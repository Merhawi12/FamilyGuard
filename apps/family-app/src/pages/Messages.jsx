import { useEffect, useState, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  children as childrenApi, chats as chatsApi,
  errorMessage, Avatar, EmptyState, Icon, useSocket,
} from '@parentix/shared';
import ChildTabs from '../components/ChildTabs';
import PageIntro from '../components/PageIntro';

const MESSAGE_TYPES = [
  { value: 'normal', label: 'Normal', icon: 'message' },
  { value: 'check_in', label: 'Check-in', icon: 'check' },
  { value: 'emergency', label: 'Emergency', icon: 'warning' },
];

const BUBBLE = {
  normal: { self: 'bg-primary-600 text-white', other: 'bg-gray-100 text-gray-800' },
  emergency: { self: 'bg-danger text-white', other: 'bg-red-50 text-red-800 border border-red-200' },
  check_in: { self: 'bg-green-600 text-white', other: 'bg-green-50 text-green-800' },
};

/**
 * The conversation with each child.
 *
 * The chat pane is sized from the visible viewport (`dvh`) rather than `vh`:
 * with `vh` on a phone the compose box sat behind the browser's own toolbar,
 * so the field a parent is trying to type into was the one part of the screen
 * they could not reach.
 */
export default function Messages() {
  const [childList, setChildList] = useState([]);
  const [selected, setSelected] = useState(null);
  const [messageList, setMessageList] = useState([]);
  const [text, setText] = useState('');
  const [msgType, setMsgType] = useState('normal');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const bottomRef = useRef(null);
  const { messages: socketMessages, setMessages: setSocketMessages } = useSocket();

  useEffect(() => {
    childrenApi.list()
      .then((r) => { setChildList(r.data); if (r.data[0]) setSelected(r.data[0]); })
      .catch(() => setError('Could not load your children.'))
      .finally(() => setLoading(false));
  }, []);

  const loadMessages = useCallback((child) => {
    chatsApi.getMessages(child.id)
      .then((r) => { setMessageList(r.data.rows || r.data); setError(''); })
      // An empty thread reads as "you have never spoken", so a failure to load
      // one has to say so rather than show the same thing.
      .catch((err) => {
        setMessageList([]);
        setError(errorMessage(err, 'Could not load this conversation.'));
      });
  }, []);

  useEffect(() => {
    if (!selected) return;
    loadMessages(selected);
  }, [selected, loadMessages]);

  // Merge real-time socket messages for the selected child.
  useEffect(() => {
    if (socketMessages.length === 0 || !selected) return;
    const relevant = socketMessages.filter((m) => m.childId === selected.id);
    if (!relevant.length) return;
    setMessageList((prev) => {
      const ids = new Set(prev.map((m) => m.id));
      const newOnes = relevant.filter((m) => !ids.has(m.id));
      return newOnes.length ? [...prev, ...newOnes] : prev;
    });
    setSocketMessages((prev) => prev.filter((m) => m.childId !== selected.id));
  }, [socketMessages, selected, setSocketMessages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messageList]);

  const send = async (e) => {
    e.preventDefault();
    if (!text.trim() || !selected) return;
    setSending(true);
    setError('');
    try {
      const r = await chatsApi.sendMessage(selected.id, { text: text.trim(), messageType: msgType });
      setMessageList((prev) => [...prev, r.data]);
      setText('');
      setMsgType('normal');
    } catch (err) {
      setError(errorMessage(err, 'Your message could not be sent.'));
    } finally {
      setSending(false);
    }
  };

  if (loading) return <p className="text-sm text-gray-400 py-8">Loading…</p>;

  if (childList.length === 0) {
    return (
      <div className="card">
        <EmptyState
          icon="message"
          title="No child profiles yet"
          description="Add a child and link their device to start a conversation."
          action={<Link to="/dashboard/children" className="btn-primary">Go to Children</Link>}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageIntro description="Messages are delivered straight to your child's device." />

      <ChildTabs items={childList} selectedId={selected?.id} onSelect={setSelected} />

      {selected && (
        <div className="card-flush flex flex-col h-[calc(100dvh-15rem)] min-h-[400px] lg:h-[calc(100dvh-13rem)]">
          <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 shrink-0">
            <Avatar name={selected.name} imageUrl={selected.avatarUrl} size="sm" />
            <div className="min-w-0">
              <p className="font-semibold text-sm text-gray-900 truncate">{selected.name}</p>
              <p className="text-xs text-gray-400">Delivered to their linked devices</p>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto scroll-touch overscroll-contain p-4 space-y-3">
            {messageList.length === 0 && (
              <EmptyState
                compact
                icon="message"
                title="No messages yet"
                description={`Say hello to ${selected.name}.`}
              />
            )}
            {messageList.map((msg) => {
              const isParent = msg.senderRole === 'parent';
              const style = BUBBLE[msg.messageType] || BUBBLE.normal;
              const type = MESSAGE_TYPES.find((t) => t.value === msg.messageType);
              return (
                <div key={msg.id} className={`flex ${isParent ? 'justify-end' : 'justify-start'}`}>
                  <div className="max-w-[80%] sm:max-w-[70%]">
                    {msg.messageType && msg.messageType !== 'normal' && (
                      <p className={`flex items-center gap-1 text-[11px] font-semibold text-gray-500 mb-1 ${isParent ? 'justify-end' : ''}`}>
                        <Icon name={type?.icon || 'message'} size={12} strokeWidth={2.2} />
                        {type?.label}
                      </p>
                    )}
                    <div
                      className={`px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed break-words ${
                        isParent ? `${style.self} rounded-br-md` : `${style.other} rounded-bl-md`
                      }`}
                    >
                      {msg.text}
                    </div>
                    <p className={`text-[11px] text-gray-400 mt-1 ${isParent ? 'text-right' : ''}`}>
                      {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>

          <div className="border-t border-gray-100 bg-gray-50 p-3 shrink-0 space-y-2">
            {error && <p className="notice-error">{error}</p>}

            <div className="flex gap-2">
              {MESSAGE_TYPES.map(({ value, label, icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMsgType(value)}
                  aria-pressed={msgType === value}
                  className={`btn btn-sm flex-1 ${
                    msgType === value
                      ? value === 'emergency'
                        ? 'bg-danger text-white'
                        : 'bg-primary-600 text-white'
                      : 'bg-white border border-gray-200 text-gray-600'
                  }`}
                >
                  <Icon name={icon} size={14} strokeWidth={2.2} />
                  <span className="truncate">{label}</span>
                </button>
              ))}
            </div>

            <form onSubmit={send} className="flex gap-2">
              <input
                className="input flex-1"
                placeholder={`Message ${selected.name}…`}
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={sending}
                aria-label="Message text"
              />
              <button
                type="submit"
                disabled={sending || !text.trim()}
                aria-label="Send message"
                className={`btn w-12 px-0 shrink-0 ${
                  msgType === 'emergency' ? 'bg-danger text-white' : 'bg-primary-600 text-white'
                }`}
              >
                <Icon name="send" size={18} />
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
