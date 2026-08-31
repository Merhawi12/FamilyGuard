import { useEffect, useRef, useState } from 'react';
import {
  children as childrenApi,
  devices as devicesApi,
  uploadChildAvatar,
  errorMessage,
  useSocket,
  Avatar,
  EmptyState,
  Icon,
  Modal,
} from '@parentix/shared';
import DeviceCard from '../components/DeviceCard';
import PageIntro from '../components/PageIntro';

/**
 * The platforms a link code can actually be redeemed on.
 *
 * The rule for this list is that a Parentix client has to exist and be
 * installable for the type — otherwise choosing one produces a link code nothing
 * can consume and a device row that stays "never connected" for ever, with no
 * indication anywhere that it never could. That is what this list was for when
 * it held Android alone.
 *
 * Windows and Mac join it because `apps/child-desktop` ships an agent for both,
 * and it redeems a code through the same `POST /devices/confirm` the phones use.
 * iPhone is still absent for the original reason: the iOS child app builds, but
 * it is not in the App Store, so there is nothing for a family to install.
 *
 * Editing an existing device keeps the wider list, because rows created before
 * this must still be able to name what they are.
 */
const DEVICE_TYPES = [
  { value: 'android', label: 'Android phone or tablet' },
  { value: 'windows', label: 'Windows computer' },
  { value: 'mac', label: 'Mac' },
];

const EDITABLE_DEVICE_TYPES = [
  ...DEVICE_TYPES,
  { value: 'ios', label: 'iPhone or iPad' },
];

/**
 * Child profiles and the devices linked to them.
 *
 * Master and detail sit side by side from `lg` up. On a phone they stack, and
 * the two forms — new child, new device link — are sheets rather than cards
 * pushed inline: a form that appears above the list shifts everything below it
 * down mid-tap, and the parent has to scroll back up to find what moved.
 */
export default function Children() {
  const [childList, setChildList] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [showChildForm, setShowChildForm] = useState(false);
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [linkData, setLinkData] = useState(null);
  const [form, setForm] = useState({ name: '', age: '' });
  /**
   * A child's name and age were write-once. `PUT /children/:id` has always
   * existed and this screen only ever used it to set an avatar, so a typo in a
   * child's name — or an age left blank at signup, which is what tunes the
   * default safety settings — could only be corrected by deleting the child, and
   * that unlinks their devices and takes their whole history with it.
   */
  const [editChild, setEditChild] = useState(null);
  const [deviceForm, setDeviceForm] = useState({ deviceName: '', type: 'android' });
  const [editDevice, setEditDevice] = useState(null);
  // Set when the link sheet is finishing an existing device rather than
  // creating one — the sheet then skips its form and goes straight to a code.
  const [linkTarget, setLinkTarget] = useState(null);
  /**
   * The device that just confirmed the code on screen.
   *
   * The sheet handed out a code and then had no idea what became of it: the
   * parent watched a code that had already been redeemed, and only found out by
   * closing the sheet, which is what triggered the reload. Since the phone is
   * usually in their other hand, that is precisely the moment they are watching
   * for.
   */
  const [linkedDevice, setLinkedDevice] = useState(null);
  const [saving, setSaving] = useState(false);
  // The device whose pause is in flight, so only that row's button disables.
  const [blocking, setBlocking] = useState(null);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);
  const { socket } = useSocket();

  // Track the selection by id so it always reflects the freshly loaded record
  // rather than a stale copy captured when the row was clicked.
  const selected = childList.find((c) => c.id === selectedId) || null;

  const load = async () => {
    try {
      const { data } = await childrenApi.list();
      setChildList(data);
      setSelectedId((current) => (data.some((c) => c.id === current) ? current : data[0]?.id ?? null));
    } catch (err) {
      setError(errorMessage(err, 'Failed to load children'));
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * A phone finished linking. The server says so the moment it happens.
   *
   * Handled on the page rather than in the socket context because this is the
   * only screen that can act on it, and because it has to do two things: turn
   * the open code sheet into a confirmation, and refresh the list underneath so
   * the new card is already there when the sheet closes.
   */
  useEffect(() => {
    if (!socket) return undefined;
    const onLinked = (device) => {
      setLinkedDevice(device);
      load();
    };
    socket.on('device:linked', onLinked);
    return () => socket.off('device:linked', onLinked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);

  /**
   * A device changed somewhere else — paused, resumed, or connected and gone.
   *
   * `setDeviceBlocked` has emitted `device_updated` to `parent:<id>` since
   * per-device control shipped, with a comment saying it is "the parent's other
   * open tabs, so a block applied on a phone shows on the laptop without a
   * reload" — and nothing anywhere listened for it. The server half of the
   * behaviour was real; the half that makes it visible did not exist, so the
   * laptop went on showing Active until it was reloaded, beside a Pause button
   * that would have answered 200 for a device already paused.
   *
   * The same event now also carries presence, sent when a device's socket
   * connects or drops (sockets/deviceEvents.js). That is what makes the status
   * dot follow a phone being switched off and coming back, rather than showing
   * whatever was true when the page happened to be loaded.
   *
   * The row is patched in place rather than calling `load()`: a block also fires
   * this in the tab that made the change, which is already refetching, and a
   * second list request racing the first would be two answers for one tap.
   *
   * **Only the fields the event actually carries are written.** Spreading a
   * fixed set of names would have a presence update — which says nothing about
   * pausing — set `blockedAt: undefined` and quietly un-pause a paused device on
   * screen. Each event describes one thing; patching exactly that keeps them
   * commutative, so whichever order two land in, the row ends up right.
   */
  useEffect(() => {
    if (!socket) return undefined;
    const onDeviceUpdated = ({ deviceId, ...changes }) => {
      if (!deviceId) return;
      const patch = Object.fromEntries(
        Object.entries(changes).filter(([, value]) => value !== undefined)
      );
      if (Object.keys(patch).length === 0) return;

      setChildList((prev) => prev.map((child) => (
        child.devices?.some((d) => d.id === deviceId)
          ? { ...child, devices: child.devices.map((d) => (d.id === deviceId ? { ...d, ...patch } : d)) }
          : child
      )));
    };
    socket.on('device_updated', onDeviceUpdated);
    return () => socket.off('device_updated', onDeviceUpdated);
  }, [socket]);

  const addChild = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await childrenApi.create({ name: form.name.trim(), age: parseInt(form.age, 10) || null });
      setForm({ name: '', age: '' });
      setShowChildForm(false);
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Failed to add child'));
    } finally {
      setSaving(false);
    }
  };

  const saveChildEdit = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await childrenApi.update(editChild.id, {
        name: editChild.name.trim(),
        // Cleared rather than skipped when emptied: a parent removing a wrong age
        // has to be able to leave it unset, not be stuck with the old value.
        age: editChild.age === '' ? null : parseInt(editChild.age, 10),
      });
      setEditChild(null);
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Could not save those details'));
    } finally {
      setSaving(false);
    }
  };

  const removeChild = async (id) => {
    if (!confirm('Remove this child? Their devices will be unlinked.')) return;
    setError('');
    try {
      await childrenApi.remove(id);
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Failed to remove child'));
    }
  };

  const generateLink = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const res = await devicesApi.generateLink({ childId: selected.id, ...deviceForm });
      setLinkedDevice(null);
      setLinkData(res.data);
    } catch (err) {
      setError(errorMessage(err, 'Failed to generate a link code'));
    } finally {
      setSaving(false);
    }
  };

  const closeLinkForm = async () => {
    setShowLinkForm(false);
    setLinkData(null);
    setLinkTarget(null);
    setLinkedDevice(null);
    setDeviceForm({ deviceName: '', type: 'android' });
    // A device may have confirmed the code while the sheet was open and the
    // socket been down — the reload is the fallback for exactly that.
    await load();
  };

  /**
   * True once the phone this sheet is about has confirmed its code.
   *
   * Matched on the device id rather than merely "something linked", so a second
   * child's phone finishing at the same moment cannot make this sheet claim the
   * wrong one is done.
   */
  const justLinked = linkedDevice && linkData?.device?.id === linkedDevice.deviceId
    ? linkedDevice
    : null;

  /* ── A device that never connected ───────────────────────────────────────
     Linking codes expire after 30 minutes and the sheet that showed one does
     not keep it. Re-issuing a code for the existing row is what lets a parent
     finish the job later, instead of deleting the device and starting over. */
  const connectDevice = async (device) => {
    setError('');
    setLinkData(null);
    setLinkedDevice(null);
    setLinkTarget(device);
    setShowLinkForm(true);
    setSaving(true);
    try {
      const res = await devicesApi.regenerateLink(device.id);
      setLinkData(res.data);
    } catch (err) {
      setError(errorMessage(err, 'Could not create a new link code'));
      setShowLinkForm(false);
      setLinkTarget(null);
    } finally {
      setSaving(false);
    }
  };

  const openDeviceEdit = (device) => {
    setError('');
    setEditDevice({ id: device.id, name: device.name, type: device.type || 'android' });
  };

  const saveDeviceEdit = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await devicesApi.update(editDevice.id, {
        name: editDevice.name.trim(),
        type: editDevice.type,
      });
      setEditDevice(null);
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Could not save that device'));
    } finally {
      setSaving(false);
    }
  };

  /**
   * Pause or unpause one device, leaving its siblings alone.
   *
   * No confirmation, unlike Remove: this is reversible with the same tap that
   * applied it, and a dialog in front of it would make an everyday action feel
   * like a dangerous one. The id is held in `blocking` so the row's button can
   * disable itself — the call is fast, but tapping it twice would otherwise send
   * a block and an unblock and leave the device in whichever arrived last.
   */
  const toggleDeviceBlock = async (device) => {
    setError('');
    setBlocking(device.id);
    try {
      if (device.blockedAt) await devicesApi.unblock(device.id);
      else await devicesApi.block(device.id);
      await load();
    } catch (err) {
      setError(errorMessage(err, `Could not ${device.blockedAt ? 'unpause' : 'pause'} that device`));
    } finally {
      setBlocking(null);
    }
  };

  // Removing a device revokes its token: the phone stops reporting and cannot
  // reconnect without being linked again. Worth a confirmation, the same as
  // removing a child, since a trash icon is easy to hit by accident.
  const removeDevice = async (id, name) => {
    if (!confirm(`Remove ${name || 'this device'}? It will stop reporting and has to be linked again.`)) return;
    setError('');
    try {
      await devicesApi.remove(id);
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Failed to remove device'));
    }
  };

  const changePhoto = async (e) => {
    const file = e.target.files?.[0];
    // Reset immediately so picking the same file again still fires onChange.
    e.target.value = '';
    if (!file || !selected) return;

    setError('');
    setUploading(true);
    try {
      const url = await uploadChildAvatar(file, { childId: selected.id });
      await childrenApi.update(selected.id, { avatarUrl: url });
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Failed to upload the photo'));
    } finally {
      setUploading(false);
    }
  };

  const removePhoto = async () => {
    setError('');
    try {
      await childrenApi.update(selected.id, { avatarUrl: '' });
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Failed to remove the photo'));
    }
  };

  return (
    <div className="space-y-5">
      <PageIntro description="Child profiles and the devices linked to them.">
        <button onClick={() => setShowChildForm(true)} className="btn-primary btn-sm">
          <Icon name="plus" size={16} strokeWidth={2.5} />
          Add child
        </button>
      </PageIntro>

      {error && <p className="notice-error">{error}</p>}

      {childList.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="children"
            title="No children yet"
            description="Add a child profile, then link their phone or tablet to start monitoring."
            action={
              <button onClick={() => setShowChildForm(true)} className="btn-primary">
                Add your first child
              </button>
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6 items-start">
          {/* Master */}
          <div className="space-y-2 lg:col-span-1">
            {childList.map((c) => {
              const active = selectedId === c.id;
              return (
                <div
                  key={c.id}
                  className={`card p-3 flex items-center gap-3 transition ${
                    active ? 'border-primary-500 ring-1 ring-primary-500' : 'hover:border-gray-200'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedId(c.id)}
                    aria-pressed={active}
                    className="flex items-center gap-3 flex-1 min-w-0 text-left min-h-[44px]"
                  >
                    <Avatar name={c.name} imageUrl={c.avatarUrl} size="sm" />
                    <span className="flex-1 min-w-0">
                      <span className="block font-medium text-gray-900 truncate">{c.name}</span>
                      <span className="block text-xs text-gray-500">
                        {c.age ? `Age ${c.age}` : 'No age set'} · {c.devices?.length || 0} device
                        {c.devices?.length === 1 ? '' : 's'}
                      </span>
                    </span>
                  </button>
                  <button
                    onClick={() => setEditChild({ id: c.id, name: c.name, age: c.age ?? '' })}
                    className="icon-btn text-gray-400 hover:text-primary-600 hover:bg-primary-50"
                    aria-label={`Edit ${c.name}`}
                  >
                    <Icon name="edit" size={18} />
                  </button>
                  <button
                    onClick={() => removeChild(c.id)}
                    className="icon-btn text-gray-400 hover:text-danger hover:bg-red-50"
                    aria-label={`Remove ${c.name}`}
                  >
                    <Icon name="trash" size={18} />
                  </button>
                </div>
              );
            })}
          </div>

          {/* Detail */}
          {selected && (
            <div className="lg:col-span-2 space-y-4">
              <div className="card text-center sm:text-left sm:flex sm:items-center sm:gap-5">
                <Avatar
                  name={selected.name}
                  imageUrl={selected.avatarUrl}
                  size="xl"
                  className="mx-auto sm:mx-0 mb-4 sm:mb-0"
                />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-gray-900 truncate">{selected.name}&apos;s photo</p>
                  <p className="text-xs text-gray-500 mt-0.5 mb-3">JPEG, PNG or WebP, up to 5 MB</p>
                  <div className="flex flex-wrap justify-center sm:justify-start gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="hidden"
                      onChange={changePhoto}
                    />
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="btn-secondary btn-sm"
                      disabled={uploading}
                    >
                      <Icon name="upload" size={15} />
                      {uploading ? 'Uploading…' : selected.avatarUrl ? 'Change photo' : 'Upload photo'}
                    </button>
                    {selected.avatarUrl && (
                      <button onClick={removePhoto} className="btn-ghost btn-sm" disabled={uploading}>
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3">
                <h2 className="section-title truncate">{selected.name}&apos;s devices</h2>
                <button onClick={() => setShowLinkForm(true)} className="btn-primary btn-sm shrink-0">
                  <Icon name="link" size={15} />
                  Link device
                </button>
              </div>

              {(selected.devices || []).length === 0 ? (
                <div className="card">
                  <EmptyState
                    compact
                    icon="phone"
                    title="No devices linked"
                    description="Install the Parentix app on their phone and enter a link code to connect it."
                    action={
                      <button onClick={() => setShowLinkForm(true)} className="btn-primary">
                        Link a device
                      </button>
                    }
                  />
                </div>
              ) : (
                <div className="space-y-3">
                  {selected.devices.map((d) => (
                    <DeviceCard
                      key={d.id}
                      device={d}
                      onRemove={removeDevice}
                      onConnect={connectDevice}
                      onEdit={openDeviceEdit}
                      onToggleBlock={toggleDeviceBlock}
                      busy={blocking === d.id}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── New child ──────────────────────────────────────────────────────── */}
      <Modal
        open={showChildForm}
        onClose={() => setShowChildForm(false)}
        title="Add a child"
        description="You can link their devices next."
      >
        <form onSubmit={addChild} className="space-y-4" id="add-child-form">
          <label className="field">
            <span className="field-label">Name</span>
            <input
              className="input"
              placeholder="e.g. Sarah"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </label>
          <label className="field">
            <span className="field-label">Age</span>
            <input
              className="input"
              type="number"
              inputMode="numeric"
              min="1"
              max="21"
              placeholder="Optional"
              value={form.age}
              onChange={(e) => setForm({ ...form, age: e.target.value })}
            />
            <span className="field-hint">Used to tune the default safety settings.</span>
          </label>
          <button type="submit" className="btn-primary btn-block" disabled={saving || !form.name.trim()}>
            {saving ? 'Adding…' : 'Add child'}
          </button>
        </form>
      </Modal>

      {/* ── Edit a child ───────────────────────────────────────────────────── */}
      <Modal
        open={!!editChild}
        onClose={() => setEditChild(null)}
        title="Edit child"
        description="The name is what you see across the dashboard; the age tunes the default safety settings."
      >
        {editChild && (
          <form onSubmit={saveChildEdit} className="space-y-4">
            <label className="field">
              <span className="field-label">Name</span>
              <input
                className="input"
                value={editChild.name}
                onChange={(e) => setEditChild({ ...editChild, name: e.target.value })}
                required
              />
            </label>
            <label className="field">
              <span className="field-label">Age</span>
              <input
                className="input"
                type="number"
                inputMode="numeric"
                min="1"
                max="21"
                placeholder="Optional"
                value={editChild.age}
                onChange={(e) => setEditChild({ ...editChild, age: e.target.value })}
              />
            </label>
            <button type="submit" className="btn-primary btn-block" disabled={saving || !editChild.name.trim()}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </form>
        )}
      </Modal>

      {/* ── Link a device ──────────────────────────────────────────────────── */}
      <Modal
        open={showLinkForm}
        onClose={closeLinkForm}
        title={linkTarget ? `Connect ${linkTarget.name}` : 'Link a device'}
        description={
          linkTarget
            ? 'This device was set up but never connected. Here is a fresh code for it.'
            : selected ? `Connect a phone or tablet to ${selected.name}.` : undefined
        }
      >
        {!linkData && linkTarget ? (
          <p className="text-sm text-gray-400 text-center py-8">Creating a code…</p>
        ) : justLinked ? (
          /* The code was redeemed while this sheet was open. Saying so is the
             whole point of the realtime event — a parent standing over the
             child's phone should not have to close the sheet to find out. */
          <div className="text-center py-4">
            <span className="w-14 h-14 rounded-full bg-green-50 text-success flex items-center justify-center mx-auto">
              <Icon name="check" size={28} strokeWidth={2.5} />
            </span>
            <p className="font-semibold text-gray-900 mt-4">
              {justLinked.name || 'That device'} is connected
            </p>
            <p className="text-sm text-gray-500 mt-1">
              It is reporting to {selected?.name || 'this child'}&apos;s profile now
              {justLinked.osVersion ? ` · ${justLinked.osVersion}` : ''}.
            </p>
            <button onClick={closeLinkForm} className="btn-primary btn-block mt-5">
              Done
            </button>
          </div>
        ) : linkData ? (
          <div className="text-center">
            <p className="text-sm text-gray-600">Enter this code in the Parentix app on their device:</p>
            <p className="text-3xl sm:text-4xl font-mono font-bold text-primary-600 tracking-[0.2em] my-4">
              {linkData.code}
            </p>
            {/* The QR code the API also returns is deliberately not drawn.
                Nothing can read it: the child app has no scanner and no camera
                dependency, so a square that plainly means "point the phone at
                this" was an instruction the product cannot carry out — and the
                parent who tried it had no way to discover that, because the
                phone would simply never respond. The eight characters below are
                the whole of how a device links today. (`linkData.qrCode` is left
                on the response for the day a scanner ships; it needs a native
                rebuild of the child app, so it is not something this screen can
                turn on by itself.) */}
            <p className="text-xs text-gray-400 mt-3">
              Type it into the Parentix app on their device — it is valid for 30 minutes.
            </p>
            {/* Not a spinner: nothing here is pending on this side. It tells the
                parent the screen is live, which is what makes the switch to the
                confirmation above read as an answer rather than a glitch. */}
            <p className="text-xs text-gray-400 mt-1">
              This page updates as soon as the device connects.
            </p>
            <button onClick={closeLinkForm} className="btn-secondary btn-block mt-5">
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={generateLink} className="space-y-4">
            <label className="field">
              <span className="field-label">Device name</span>
              <input
                className="input"
                placeholder="e.g. Sarah's Phone"
                value={deviceForm.deviceName}
                onChange={(e) => setDeviceForm({ ...deviceForm, deviceName: e.target.value })}
                required
              />
            </label>
            {/* A dropdown holding one option is not a choice, and reads as a
                broken control: it opens, shows the thing already selected, and
                closes having changed nothing. The sign-in screen hides its
                method tabs on the same rule. When Android was the only platform
                with a client, this form stated it rather than offering to pick
                it — and the condition, rather than deleting the field, is what
                made the dropdown come back on its own the day a second type was
                added. It has: the desktop agent covers Windows and macOS, so
                the select renders and the sentence below is the branch nothing
                takes any more. Both are kept, because the list is a function of
                which clients exist and that has now moved in both directions. */}
            {DEVICE_TYPES.length > 1 ? (
              <label className="field">
                <span className="field-label">Device type</span>
                <select
                  className="input"
                  value={deviceForm.type}
                  onChange={(e) => setDeviceForm({ ...deviceForm, type: e.target.value })}
                >
                  {DEVICE_TYPES.map(({ value, label }) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
            ) : (
              <p className="text-sm text-gray-500">
                Device type:{' '}
                <span className="font-medium text-gray-700">{DEVICE_TYPES[0].label}</span>
              </p>
            )}
            <button
              type="submit"
              className="btn-primary btn-block"
              disabled={saving || !deviceForm.deviceName.trim()}
            >
              <Icon name="qr" size={16} />
              {saving ? 'Generating…' : 'Generate code'}
            </button>
          </form>
        )}
      </Modal>

      {/* ── Edit a device ──────────────────────────────────────────────────── */}
      <Modal
        open={!!editDevice}
        onClose={() => setEditDevice(null)}
        title="Edit device"
        description="The name is what you see across the dashboard; the type only picks its icon."
      >
        {editDevice && (
          <form onSubmit={saveDeviceEdit} className="space-y-4">
            <label className="field">
              <span className="field-label">Device name</span>
              <input
                className="input"
                placeholder="e.g. Sarah's Phone"
                value={editDevice.name}
                onChange={(e) => setEditDevice({ ...editDevice, name: e.target.value })}
                required
              />
            </label>
            <label className="field">
              <span className="field-label">Device type</span>
              <select
                className="input"
                value={editDevice.type}
                onChange={(e) => setEditDevice({ ...editDevice, type: e.target.value })}
              >
                {EDITABLE_DEVICE_TYPES.map(({ value, label }) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="btn-primary btn-block"
              disabled={saving || !editDevice.name.trim()}
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </form>
        )}
      </Modal>
    </div>
  );
}
