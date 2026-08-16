import { useState, useEffect } from 'react';
import {
  contacts as contactsApi, children as childrenApi,
  errorMessage, Avatar, EmptyState, Icon, Modal,
} from '@parentix/shared';
import ChildTabs from '../components/ChildTabs';
import PageIntro from '../components/PageIntro';

const RELATIONSHIPS = ['family', 'friend', 'teacher', 'coach', 'other'];

const RELATIONSHIP_BADGE = {
  family: 'bg-blue-100 text-blue-700',
  friend: 'bg-green-100 text-green-700',
  teacher: 'bg-purple-100 text-purple-700',
  coach: 'bg-orange-100 text-orange-700',
  other: 'bg-gray-100 text-gray-600',
};

const EMPTY_FORM = { childId: '', name: '', phoneNumber: '', email: '', relationship: 'other', notes: '' };

/**
 * The people a child is allowed to be contacted by.
 *
 * What this really is, as of today: the parent's own record of who is in their
 * child's life, synced down to the device and kept there.
 *
 * It used to say more than that — "anyone off the list raises an unapproved
 * contact alert" — and the device genuinely holds the approved list and
 * genuinely knows how to match a number against it. What it does not have is any
 * way to *see* a number: the child app declares no `READ_PHONE_STATE`,
 * `READ_CALL_LOG` or `RECEIVE_SMS`, all of which are Play-restricted and a
 * product decision rather than an oversight. So nothing has ever called the
 * check, no `unknown_contact` alert has ever been raised, and a parent blocking
 * a contact here was told an alert would follow that could not.
 *
 * The list and the approval state are still worth keeping — they are what a
 * future call/SMS watcher would enforce, and they are already what the device
 * caches — so the feature stays and the promise goes. The page now says what it
 * does. See services/api/src/config/alertTypes.js.
 */
export default function Contacts() {
  const [children, setChildren] = useState([]);
  const [selectedChild, setSelectedChild] = useState(null);
  const [contactList, setContactList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    childrenApi.list()
      .then((r) => { setChildren(r.data); if (r.data[0]) setSelectedChild(r.data[0]); })
      .catch(() => setError('Could not load your children.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedChild) return;
    setLoading(true);
    contactsApi.list(selectedChild.id)
      .then((r) => { setContactList(r.data); setError(''); })
      // An empty list here reads as "nobody is allowed to contact this child",
      // which is a statement about the rules rather than about the request.
      .catch((err) => {
        setContactList([]);
        setError(errorMessage(err, 'Could not load contacts.'));
      })
      .finally(() => setLoading(false));
  }, [selectedChild]);

  const flash = (message) => { setSaved(message); setTimeout(() => setSaved(''), 2500); };

  const openAdd = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, childId: selectedChild?.id || children[0]?.id || '' });
    setFormError('');
    setShowForm(true);
  };

  const openEdit = (c) => {
    setEditingId(c.id);
    setForm({
      childId: c.childId,
      name: c.name,
      phoneNumber: c.phoneNumber || '',
      email: c.email || '',
      relationship: c.relationship,
      notes: c.notes || '',
    });
    setFormError('');
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError('');
    setSaving(true);
    try {
      if (editingId) {
        const res = await contactsApi.update(editingId, form);
        setContactList((prev) => prev.map((c) => (c.id === editingId ? res.data : c)));
        flash('Contact updated.');
      } else {
        const res = await contactsApi.create(form);
        setContactList((prev) => [...prev, res.data]);
        flash('Contact added.');
      }
      setShowForm(false);
    } catch (err) {
      setFormError(errorMessage(err, 'Could not save that contact.'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (contact) => {
    if (!window.confirm(`Delete ${contact.name}?`)) return;
    try {
      await contactsApi.remove(contact.id);
      setContactList((prev) => prev.filter((c) => c.id !== contact.id));
    } catch (err) {
      setError(errorMessage(err, 'Could not delete that contact.'));
    }
  };

  const toggleApproved = async (contact) => {
    setError('');
    try {
      const res = await contactsApi.update(contact.id, { isApproved: !contact.isApproved });
      setContactList((prev) => prev.map((c) => (c.id === contact.id ? res.data : c)));
    } catch (err) {
      setError(errorMessage(err, 'Could not update that contact.'));
    }
  };

  return (
    <div className="space-y-5">
      <PageIntro description="The people in your children's lives, and who you have approved.">
        <button onClick={openAdd} disabled={children.length === 0} className="btn-primary btn-sm">
          <Icon name="plus" size={16} strokeWidth={2.5} />
          Add contact
        </button>
      </PageIntro>

      {error && <p className="notice-error">{error}</p>}
      {saved && <p className="notice-success">{saved}</p>}

      <ChildTabs items={children} selectedId={selectedChild?.id} onSelect={setSelectedChild} />

      {children.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="children"
            title="No child profiles yet"
            description="Add a child under Children before managing their contacts."
          />
        </div>
      ) : loading ? (
        <p className="text-sm text-gray-400 py-8">Loading contacts…</p>
      ) : contactList.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="contacts"
            title="No contacts yet"
            description={`Add the people ${selectedChild?.name || 'this child'} is allowed to hear from.`}
            action={<button onClick={openAdd} className="btn-primary">Add a contact</button>}
          />
        </div>
      ) : (
        <div className="space-y-3 max-w-3xl">
          {contactList.map((contact) => (
            <div key={contact.id} className="card p-4">
              <div className="flex items-start gap-3">
                <Avatar name={contact.name} size="sm" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-medium text-gray-900 truncate">{contact.name}</p>
                    <span
                      className={`badge capitalize ${
                        RELATIONSHIP_BADGE[contact.relationship] || RELATIONSHIP_BADGE.other
                      }`}
                    >
                      {contact.relationship}
                    </span>
                  </div>
                  <div className="mt-1 space-y-0.5">
                    {contact.phoneNumber && (
                      <p className="text-xs text-gray-500 flex items-center gap-1.5">
                        <Icon name="call" size={12} /> {contact.phoneNumber}
                      </p>
                    )}
                    {contact.email && (
                      <p className="text-xs text-gray-500 flex items-center gap-1.5 truncate">
                        <Icon name="mail" size={12} /> {contact.email}
                      </p>
                    )}
                    {contact.notes && <p className="text-xs text-gray-400 italic">{contact.notes}</p>}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-50">
                <button
                  onClick={() => toggleApproved(contact)}
                  className={`btn btn-sm flex-1 ${
                    contact.isApproved
                      ? 'bg-green-50 text-green-700 border border-green-200 hover:bg-green-100'
                      : 'bg-red-50 text-red-700 border border-red-200 hover:bg-red-100'
                  }`}
                  title={contact.isApproved ? 'Block this contact' : 'Approve this contact'}
                >
                  <Icon name={contact.isApproved ? 'check' : 'block'} size={15} strokeWidth={2.2} />
                  {contact.isApproved ? 'Approved' : 'Blocked'}
                </button>
                <button
                  onClick={() => openEdit(contact)}
                  className="icon-btn"
                  aria-label={`Edit ${contact.name}`}
                >
                  <Icon name="edit" size={18} />
                </button>
                <button
                  onClick={() => handleDelete(contact)}
                  className="icon-btn hover:text-danger hover:bg-red-50"
                  aria-label={`Delete ${contact.name}`}
                >
                  <Icon name="trash" size={18} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title={editingId ? 'Edit contact' : 'Add contact'}
        description="Approved contacts are synced to your child's device and kept there."
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          {!editingId && children.length > 1 && (
            <label className="field">
              <span className="field-label">Child</span>
              <select
                className="input"
                value={form.childId}
                onChange={(e) => setForm((p) => ({ ...p, childId: e.target.value }))}
              >
                {children.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          )}
          <label className="field">
            <span className="field-label">Name</span>
            <input
              className="input" required value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
            />
          </label>
          <label className="field">
            <span className="field-label">Phone number</span>
            <input
              className="input" type="tel" inputMode="tel" value={form.phoneNumber}
              onChange={(e) => setForm((p) => ({ ...p, phoneNumber: e.target.value }))}
            />
          </label>
          <label className="field">
            <span className="field-label">Email</span>
            <input
              className="input" type="email" inputMode="email" value={form.email}
              onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
            />
          </label>
          <label className="field">
            <span className="field-label">Relationship</span>
            <select
              className="input" value={form.relationship}
              onChange={(e) => setForm((p) => ({ ...p, relationship: e.target.value }))}
            >
              {RELATIONSHIPS.map((r) => (
                <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Notes</span>
            <input
              className="input" placeholder="Optional" value={form.notes}
              onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
            />
          </label>

          {formError && <p className="notice-error">{formError}</p>}

          <div className="flex gap-3 pt-1">
            <button type="submit" className="btn-primary flex-1" disabled={saving || !form.name.trim()}>
              {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add contact'}
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="btn-secondary flex-1">
              Cancel
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
