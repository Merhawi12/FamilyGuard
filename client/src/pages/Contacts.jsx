import { useState, useEffect } from 'react';
import { contacts as contactsApi, children as childrenApi } from '../services/api';

const RELATIONSHIPS = ['family', 'friend', 'teacher', 'coach', 'other'];

const EMPTY_FORM = { childId: '', name: '', phoneNumber: '', email: '', relationship: 'other', notes: '' };

export default function Contacts() {
  const [children, setChildren] = useState([]);
  const [selectedChild, setSelectedChild] = useState('');
  const [contactList, setContactList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    childrenApi.list().then(r => {
      setChildren(r.data);
      if (r.data.length > 0) setSelectedChild(r.data[0].id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedChild) return;
    setLoading(true);
    contactsApi.list(selectedChild)
      .then(r => setContactList(r.data))
      .catch(() => setContactList([]))
      .finally(() => setLoading(false));
  }, [selectedChild]);

  const openAdd = () => {
    if (children.length === 0) {
      setError('Add a child profile first before creating contacts.');
      return;
    }
    setEditingId(null);
    setForm({ ...EMPTY_FORM, childId: selectedChild || children[0].id });
    setError('');
    setShowForm(true);
  };

  const openEdit = (c) => {
    setEditingId(c.id);
    setForm({ childId: c.childId, name: c.name, phoneNumber: c.phoneNumber || '', email: c.email || '', relationship: c.relationship, notes: c.notes || '' });
    setError('');
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      if (editingId) {
        const res = await contactsApi.update(editingId, form);
        setContactList(prev => prev.map(c => c.id === editingId ? res.data : c));
        setSaved('Contact updated');
      } else {
        const res = await contactsApi.create(form);
        setContactList(prev => [...prev, res.data]);
        setSaved('Contact added');
      }
      setShowForm(false);
      setTimeout(() => setSaved(''), 2500);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save contact');
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this contact?')) return;
    try {
      await contactsApi.remove(id);
      setContactList(prev => prev.filter(c => c.id !== id));
    } catch {
      setError('Failed to delete contact');
    }
  };

  const toggleApproved = async (contact) => {
    try {
      const res = await contactsApi.update(contact.id, { isApproved: !contact.isApproved });
      setContactList(prev => prev.map(c => c.id === contact.id ? res.data : c));
    } catch {
      setError('Failed to update contact');
    }
  };

  const relationshipColor = {
    family: 'bg-blue-100 text-blue-700',
    friend: 'bg-green-100 text-green-700',
    teacher: 'bg-purple-100 text-purple-700',
    coach: 'bg-orange-100 text-orange-700',
    other: 'bg-gray-100 text-gray-600',
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Contacts</h1>
          <p className="text-gray-500 text-sm mt-1">Manage approved contacts for your children</p>
        </div>
        <button onClick={openAdd} disabled={children.length === 0} className="btn-primary text-sm disabled:opacity-50 disabled:cursor-not-allowed">+ Add Contact</button>
      </div>

      {saved && <div className="p-3 bg-green-50 text-green-700 rounded-xl text-sm">{saved}</div>}
      {error && <div className="p-3 bg-red-50 text-red-700 rounded-xl text-sm">{error}</div>}

      {/* Child selector */}
      {children.length > 1 && (
        <div className="flex gap-2 flex-wrap">
          {children.map(child => (
            <button
              key={child.id}
              onClick={() => setSelectedChild(child.id)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium border transition ${selectedChild === child.id ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-200 hover:border-blue-400'}`}
            >
              {child.name}
            </button>
          ))}
        </div>
      )}

      {/* Contact list */}
      <div className="card">
        {children.length === 0 ? (
          <div className="text-center py-10 text-gray-400">
            <p className="text-4xl mb-3">👶</p>
            <p className="font-medium">No child profiles yet</p>
            <p className="text-sm mt-1">Add a child under the Children page before managing contacts</p>
          </div>
        ) : loading ? (
          <p className="text-sm text-gray-400">Loading contacts…</p>
        ) : contactList.length === 0 ? (
          <div className="text-center py-10 text-gray-400">
            <p className="text-4xl mb-3">👥</p>
            <p className="font-medium">No contacts yet</p>
            <p className="text-sm mt-1">Add trusted contacts for this child</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {contactList.map(contact => (
              <div key={contact.id} className="flex items-center gap-4 py-3">
                <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold text-sm shrink-0">
                  {contact.name[0].toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-medium text-sm">{contact.name}</p>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${relationshipColor[contact.relationship] || relationshipColor.other}`}>
                      {contact.relationship}
                    </span>
                    {!contact.isApproved && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-600 font-medium">Blocked</span>
                    )}
                  </div>
                  <div className="flex gap-3 mt-0.5 flex-wrap">
                    {contact.phoneNumber && <p className="text-xs text-gray-400">📞 {contact.phoneNumber}</p>}
                    {contact.email && <p className="text-xs text-gray-400">✉️ {contact.email}</p>}
                    {contact.notes && <p className="text-xs text-gray-400 italic">{contact.notes}</p>}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => toggleApproved(contact)}
                    title={contact.isApproved ? 'Block contact' : 'Approve contact'}
                    className={`text-xs px-2 py-1 rounded-lg border transition ${contact.isApproved ? 'border-green-200 text-green-600 hover:bg-green-50' : 'border-red-200 text-red-600 hover:bg-red-50'}`}
                  >
                    {contact.isApproved ? '✓ Approved' : '✗ Blocked'}
                  </button>
                  <button onClick={() => openEdit(contact)} className="text-xs text-blue-500 hover:underline">Edit</button>
                  <button onClick={() => handleDelete(contact.id)} className="text-xs text-red-400 hover:underline">Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add / Edit form modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md">
            <h2 className="font-semibold text-lg mb-4">{editingId ? 'Edit Contact' : 'Add Contact'}</h2>
            <form onSubmit={handleSubmit} className="space-y-3">
              {!editingId && children.length > 1 && (
                <label className="block">
                  <span className="text-sm text-gray-500">Child</span>
                  <select className="input mt-1" value={form.childId} onChange={e => setForm(p => ({ ...p, childId: e.target.value }))}>
                    {children.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
              )}
              <label className="block">
                <span className="text-sm text-gray-500">Name *</span>
                <input className="input mt-1" required value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
              </label>
              <label className="block">
                <span className="text-sm text-gray-500">Phone number</span>
                <input className="input mt-1" type="tel" value={form.phoneNumber} onChange={e => setForm(p => ({ ...p, phoneNumber: e.target.value }))} />
              </label>
              <label className="block">
                <span className="text-sm text-gray-500">Email</span>
                <input className="input mt-1" type="email" value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} />
              </label>
              <label className="block">
                <span className="text-sm text-gray-500">Relationship</span>
                <select className="input mt-1" value={form.relationship} onChange={e => setForm(p => ({ ...p, relationship: e.target.value }))}>
                  {RELATIONSHIPS.map(r => <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-sm text-gray-500">Notes</span>
                <input className="input mt-1" value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
              </label>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <div className="flex gap-3 pt-2">
                <button type="submit" className="btn-primary flex-1">{editingId ? 'Save Changes' : 'Add Contact'}</button>
                <button type="button" onClick={() => setShowForm(false)} className="flex-1 py-2 rounded-xl border border-gray-200 text-gray-600 hover:bg-gray-50 text-sm">Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
