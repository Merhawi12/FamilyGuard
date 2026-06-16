import { useEffect, useState, useRef, useCallback } from 'react';
import { children as childrenApi, chats as chatsApi } from '../services/api';
import { useSocket } from '../context/SocketContext';

const MESSAGE_TYPE_CONFIG = {
  normal:    { label: '', bgSelf: 'bg-blue-600 text-white', bgOther: 'bg-gray-100 text-gray-800' },
  emergency: { label: '🚨 Emergency', bgSelf: 'bg-red-600 text-white', bgOther: 'bg-red-100 text-red-800 border border-red-300' },
  check_in:  { label: '✅ Check-in', bgSelf: 'bg-green-600 text-white', bgOther: 'bg-green-100 text-green-800' },
};

export default function Messages() {
  const [childList, setChildList] = useState([]);
  const [selected, setSelected] = useState(null);
  const [messageList, setMessageList] = useState([]);
  const [text, setText] = useState('');
  const [msgType, setMsgType] = useState('normal');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const bottomRef = useRef(null);
  const { messages: socketMessages, setMessages: setSocketMessages } = useSocket();

  useEffect(() => {
    childrenApi.list().then((r) => {
      setChildList(r.data);
      if (r.data[0]) setSelected(r.data[0]);
    }).finally(() => setLoading(false));
  }, []);

  const loadMessages = useCallback((child) => {
    chatsApi.getMessages(child.id).then((r) => setMessageList(r.data.rows || r.data));
  }, []);

  useEffect(() => {
    if (!selected) return;
    loadMessages(selected);
  }, [selected, loadMessages]);

  // Merge real-time socket messages for the selected child
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

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messageList]);

  const send = async (e) => {
    e.preventDefault();
    if (!text.trim() || !selected) return;
    setSending(true);
    try {
      const r = await chatsApi.sendMessage(selected.id, { text: text.trim(), messageType: msgType });
      setMessageList((prev) => [...prev, r.data]);
      setText('');
      setMsgType('normal');
    } finally {
      setSending(false);
    }
  };

  const unreadCount = (childId) =>
    socketMessages.filter((m) => m.childId === childId && m.senderRole === 'child').length;

  if (loading) return <div className="text-gray-400 text-sm p-4">Loading...</div>;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl md:text-2xl font-bold text-gray-900">Messages</h1>
        <p className="text-gray-500 text-sm mt-1">Send and receive messages with your children</p>
      </div>

      {childList.length === 0 ? (
        <div className="card text-center py-12">
          <span className="text-5xl">💬</span>
          <h2 className="text-lg font-semibold mt-4 mb-2">No children added yet</h2>
          <p className="text-gray-500 text-sm mb-4">Add a child profile to start messaging.</p>
          <a href="/dashboard/children" className="btn-primary inline-block px-6">Go to Children →</a>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 md:gap-6" style={{ height: 'calc(100vh - 220px)', minHeight: '480px' }}>
          {/* Child list */}
          <div className="md:col-span-1 flex flex-col gap-1 overflow-y-auto">
            {childList.map((c) => {
              const unread = unreadCount(c.id);
              return (
                <button
                  key={c.id}
                  onClick={() => setSelected(c)}
                  className={`flex items-center gap-3 px-3 py-3 rounded-xl text-left transition ${
                    selected?.id === c.id ? 'bg-blue-600 text-white' : 'bg-white border border-gray-100 hover:bg-gray-50'
                  }`}
                >
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm shrink-0 ${
                    selected?.id === c.id ? 'bg-white/20 text-white' : 'bg-blue-100 text-blue-600'
                  }`}>
                    {c.name[0]}
                  </div>
                  <span className="font-medium text-sm flex-1 truncate">{c.name}</span>
                  {unread > 0 && (
                    <span className="w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center shrink-0">
                      {unread}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Chat window */}
          {selected && (
            <div className="md:col-span-3 card p-0 flex flex-col overflow-hidden">
              {/* Chat header */}
              <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3">
                <div className="w-9 h-9 bg-blue-100 rounded-full flex items-center justify-center font-bold text-blue-600 text-sm shrink-0">
                  {selected.name[0]}
                </div>
                <div>
                  <p className="font-semibold text-sm">{selected.name}</p>
                  <p className="text-xs text-gray-400">Messages are delivered to the child's device</p>
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {messageList.length === 0 && (
                  <div className="text-center text-gray-400 text-sm py-10">
                    No messages yet. Send the first one!
                  </div>
                )}
                {messageList.map((msg) => {
                  const isParent = msg.senderRole === 'parent';
                  const config = MESSAGE_TYPE_CONFIG[msg.messageType] || MESSAGE_TYPE_CONFIG.normal;
                  return (
                    <div key={msg.id} className={`flex ${isParent ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[75%] space-y-1`}>
                        {config.label && (
                          <p className={`text-xs font-semibold ${isParent ? 'text-right' : 'text-left'} text-gray-500`}>
                            {config.label}
                          </p>
                        )}
                        <div className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                          isParent
                            ? `${config.bgSelf} rounded-br-sm`
                            : `${config.bgOther} rounded-bl-sm`
                        }`}>
                          {msg.text}
                        </div>
                        <p className={`text-xs text-gray-400 ${isParent ? 'text-right' : 'text-left'}`}>
                          {isParent ? 'You' : selected.name} · {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </div>
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>

              {/* Compose */}
              <div className="px-4 py-3 border-t border-gray-100 bg-gray-50">
                <form onSubmit={send} className="flex flex-col gap-2">
                  <div className="flex gap-2">
                    {[
                      { value: 'normal',    label: '💬 Normal' },
                      { value: 'check_in',  label: '✅ Check-in' },
                      { value: 'emergency', label: '🚨 Emergency' },
                    ].map(({ value, label }) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setMsgType(value)}
                        className={`text-xs px-2.5 py-1 rounded-lg border transition ${
                          msgType === value
                            ? value === 'emergency'
                              ? 'bg-red-600 text-white border-red-600'
                              : 'bg-blue-600 text-white border-blue-600'
                            : 'border-gray-200 text-gray-600 hover:bg-gray-100'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input
                      className="input flex-1"
                      placeholder={`Message to ${selected.name}…`}
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      disabled={sending}
                    />
                    <button
                      type="submit"
                      disabled={sending || !text.trim()}
                      className={`px-4 py-2 rounded-xl font-medium text-sm transition disabled:opacity-50 ${
                        msgType === 'emergency'
                          ? 'bg-red-600 text-white hover:bg-red-700'
                          : 'bg-blue-600 text-white hover:bg-blue-700'
                      }`}
                    >
                      {sending ? '…' : 'Send'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
