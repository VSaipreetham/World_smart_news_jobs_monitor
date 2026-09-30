import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowUpRight, BookOpen, Clock3, LockKeyhole, MessageSquare, RefreshCw, Send, Sparkles, Trash2 } from 'lucide-react';
import { getOwnerKey } from './automationApi';
import { navigateWorkspace } from './workspaceNavigation';
import { normalizeSession, safeSourceUrl, sessionTime } from './intelligenceSessionModel';
import './IntelligenceSession.css';

async function readSession(response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.message || data?.error || `Intelligence session is unavailable (${response.status}).`);
  if (!data || typeof data !== 'object') throw new Error('The intelligence session returned an invalid response. Refresh after the backend is available.');
  return normalizeSession(data);
}

export default function IntelligenceSession({ request }) {
  const [session, setSession] = useState(null);
  const [message, setMessage] = useState('');
  const [view, setView] = useState('brief');
  const [pending, setPending] = useState('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requestSequence = useRef(0);
  const mounted = useRef(true);
  const pendingRef = useRef('loading');
  const submission = useRef(null);
  const messageList = useRef(null);
  const headingId = useId();
  const inputId = useId();
  const ownerConnected = Boolean(getOwnerKey());

  const refresh = useCallback(async (signal, quiet = false) => {
    const sequence = ++requestSequence.current;
    if (!quiet) { setPending('refresh'); pendingRef.current = 'refresh'; setError(''); }
    try {
      const next = await readSession(await request('/api/intelligence/session', { signal }));
      if (mounted.current && !signal?.aborted && sequence === requestSequence.current) setSession(next);
    } catch (failure) {
      if (mounted.current && !signal?.aborted && sequence === requestSequence.current) setError(failure.message || 'Unable to refresh the intelligence session.');
    } finally {
      if (mounted.current && !signal?.aborted && sequence === requestSequence.current) { setPending(''); pendingRef.current = ''; }
    }
  }, [request]);

  useEffect(() => {
    const controller = new AbortController();
    mounted.current = true;
    refresh(controller.signal);
    const timer = setInterval(() => {
      if (!pendingRef.current && document.visibilityState !== 'hidden') refresh(controller.signal, true);
    }, 5 * 60 * 1000);
    return () => { mounted.current = false; controller.abort(); clearInterval(timer); };
  }, [refresh]);

  useEffect(() => {
    if (view === 'conversation' && messageList.current) messageList.current.scrollTop = messageList.current.scrollHeight;
  }, [session?.messages.length, view]);

  async function mutate(path, body, action) {
    const sequence = ++requestSequence.current;
    setPending(action); pendingRef.current = action; setError(''); setNotice('');
    try {
      const next = await readSession(await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
      if (!mounted.current || sequence !== requestSequence.current) return;
      setSession(next);
      if (action === 'send') { setMessage(''); submission.current = null; setView('conversation'); }
      if (action === 'cleanup') setNotice('Older updates cleared. Your latest brief and recent exchange are kept.');
    } catch (failure) {
      if (mounted.current && sequence === requestSequence.current) setError(`${failure.message || 'The request could not be completed.'}${action === 'send' ? ' Refresh the session before retrying to check whether your message was saved.' : ''}`);
    } finally {
      if (mounted.current && sequence === requestSequence.current) { setPending(''); pendingRef.current = ''; }
    }
  }

  function send(event) {
    event.preventDefault();
    if (pendingRef.current || !message.trim() || !ownerConnected) return;
    const text = message.trim();
    if (submission.current?.message !== text) submission.current = { message: text, requestId: crypto.randomUUID() };
    mutate('/api/intelligence/messages', submission.current, 'send');
  }

  const messages = session?.messages || [];
  const sources = session?.sources || [];
  return <section className="intelligence-session" aria-labelledby={headingId} aria-busy={Boolean(pending)}>
    <div className="intelligence-heading">
      <span className="intelligence-mark"><Sparkles size={18} aria-hidden="true" /></span>
      <div><h2 id={headingId}>Daily World Intelligence</h2><p>One continuing conversation</p></div>
      <button className="intelligence-icon-button" type="button" onClick={() => refresh()} disabled={Boolean(pending)} aria-label="Refresh intelligence session" title="Refresh this session"><RefreshCw size={15} className={pending === 'refresh' ? 'intelligence-spinning' : ''} /></button>
    </div>
    <div className="intelligence-meta"><span><Clock3 size={12} /> {session ? sessionTime(session.updatedAt) : 'Connecting…'}</span><span>{session?.retentionDays || 7}-day history</span></div>
    <div className="intelligence-tabs" aria-label="Intelligence view">
      <button type="button" onClick={() => setView('brief')} aria-pressed={view === 'brief'}><Sparkles size={13} /> Brief</button>
      <button type="button" onClick={() => setView('conversation')} aria-pressed={view === 'conversation'}><MessageSquare size={13} /> Chat {messages.length > 0 && <span>{messages.length}</span>}</button>
      <button type="button" onClick={() => setView('sources')} aria-pressed={view === 'sources'}><BookOpen size={13} /> Sources {session && <span>{sources.length}</span>}</button>
    </div>

    {error && <div className="intelligence-error" role="alert">{error}</div>}
    {notice && <div className="intelligence-notice" role="status">{notice}</div>}
    {view === 'brief' && <div className="intelligence-brief">
      {session?.brief.summary_news || session?.brief.summary_jobs ? <>
        {session.brief.summary_news && <p>{session.brief.summary_news}</p>}
        {session.brief.summary_jobs && <div className="intelligence-hiring"><span>Hiring signals</span><p>{session.brief.summary_jobs}</p></div>}
      </> : <p className="intelligence-empty">{pending ? 'Loading your latest brief…' : 'Your next verified news update will appear here. Sources and messages stay in this session.'}</p>}
    </div>}

    {view === 'conversation' && <div className="intelligence-conversation" ref={messageList} role="log" aria-label="Ongoing intelligence conversation" aria-live="polite">
      {messages.length ? messages.map(item => <article key={item.id} className={`intelligence-message intelligence-message-${item.role}`}><div><strong>{item.role === 'user' ? 'You' : 'World Intelligence'}</strong><time dateTime={item.createdAt}>{sessionTime(item.createdAt)}</time></div><p>{item.content}</p>{Array.isArray(item.sources) && <div className="intelligence-citations">{item.sources.filter(source => safeSourceUrl(source.url)).map(source => <a key={source.id || source.url} href={safeSourceUrl(source.url)} target="_blank" rel="noopener noreferrer">[{source.number}] {source.title}</a>)}</div>}{item.provider && <small>{item.provider}</small>}</article>) : <p className="intelligence-empty">{ownerConnected ? 'Ask about the latest news, compare sources, or explore how a development affects your job search.' : 'Connect owner access to continue your private conversation.'}</p>}
      {pending === 'send' && <p className="intelligence-thinking" role="status">Reviewing recent sources…</p>}
    </div>}

    {view === 'sources' && <div className="intelligence-sources">
      {sources.length ? sources.map(item => <a key={item.id || item.url} href={item.url} target="_blank" rel="noopener noreferrer"><div><strong>{item.title}</strong><small>{item.source || new URL(item.url).hostname} · {item.publishedAt ? sessionTime(item.publishedAt) : item.firstSeenAt ? `Collected ${sessionTime(item.firstSeenAt)}` : 'Date unavailable'}</small></div><ArrowUpRight size={15} aria-hidden="true" /></a>) : <p className="intelligence-empty">No recent sources are available yet. Older sources expire automatically.</p>}
    </div>}

    <form className="intelligence-composer" onSubmit={send}>
      <label className="intelligence-sr-only" htmlFor={inputId}>Ask World Intelligence</label>
      <textarea id={inputId} value={message} onChange={event => setMessage(event.target.value)} maxLength={2000} rows={2} placeholder={ownerConnected ? 'Ask a follow-up in this session…' : 'Connect owner access to ask a question'} disabled={!ownerConnected || pending === 'send'} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send(event); } }} />
      <button type="submit" disabled={!ownerConnected || Boolean(pending) || !message.trim()} aria-label="Send question"><Send size={16} /></button>
    </form>
    <div className="intelligence-footer">
      {ownerConnected ? <button type="button" onClick={() => mutate('/api/intelligence/cleanup', { clearConversation: false }, 'cleanup')} disabled={Boolean(pending) || !session}><Trash2 size={12} /> {pending === 'cleanup' ? 'Clearing…' : 'Clear older updates'}</button> : <button type="button" onClick={() => navigateWorkspace('jobs')}><LockKeyhole size={12} /> Connect owner access</button>}
      <span>Recent context only</span>
    </div>
  </section>;
}
