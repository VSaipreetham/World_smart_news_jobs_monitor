import { createElement, useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  Activity, ArrowDownToLine, ArrowRight, ArrowUpRight, Bell, BookOpen,
  Bot, BriefcaseBusiness, Building2, Check, CheckCheck, ChevronLeft,
  ChevronRight, CircleHelp, Clock3, Database, ExternalLink, FileText,
  Filter, Globe2, LayoutDashboard, Leaf, LockKeyhole, Mail, MapPin,
  Menu, Play, RefreshCw, Search, Send, Settings2, ShieldCheck, Sparkles,
  Upload, UserRound, Workflow, X,
} from 'lucide-react';
import { automationApi, downloadJson, downloadPrivateFile, hasOwnerKey, isReadOnlyPreview, setOwnerKey } from './automationApi';
import { navigateWorkspace } from './workspaceNavigation';
import './JobWorkspace.css';

const NAVIGATION = [
  ['overview', 'Overview', LayoutDashboard], ['jobs', 'Find jobs', BriefcaseBusiness],
  ['applications', 'Applications', FileText], ['companies', 'Companies', Building2],
  ['research', 'AI research', Sparkles], ['profile', 'My profile', UserRound],
  ['automation', 'Automation', Workflow],
];
const FILTERS = {
  locations: ['Hyderabad'], keywords: ['AI', 'ML', 'GenAI', 'Machine Learning'],
  excludeKeywords: ['internship'], skills: ['Python', 'RAG', 'LangGraph'],
  companies: [], excludeCompanies: [], sources: [], workModes: [], employmentTypes: [],
  minSalaryLpa: 30, maxRequiredYears: 3, maxAgeDays: 30, minMatch: 45,
  includeUnknownSalary: true, includeUnknownExperience: true, includeUnknownDate: true, verifiedOnly: true,
};
const initialProfile = { name: '', email: '', phone: '', city: '', skills: [], experienceYears: 3,
  noticeDays: 60, expectedCtcLpa: 35, currentCtcLpa: '', minimumCtcLpa: 30,
  currentEmployer: '', linkedin: '', github: '', portfolio: '', resumeText: '',
  workAuthorization: '', willingToRelocate: true, workModes: ['onsite', 'hybrid', 'remote'] };
const initialSettings = { enabled: false, intervalMinutes: 60, mode: 'RM', slackEnabled: false, sourcesPerRun: 20, useJev: false, useQdrant: false };
const number = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '—';
const asList = value => Array.isArray(value) ? value : [];
const split = value => value.split(',').map(item => item.trim()).filter(Boolean);
const words = value => String(value || '').replaceAll('_', ' ');
const json = value => { try { return typeof value === 'string' ? JSON.parse(value) : value || {}; } catch { return {}; } };
const date = value => { const time = new Date(Number(value) || value); return value && Number.isFinite(time.getTime()) ? time.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Not checked yet'; };
function safeLink(value) { try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null; } catch { return null; } }
function jobData(row) { return { ...json(row.payload || row.job), ...row, evaluation: json(row.evaluation) }; }

function Badge({ children, tone = 'neutral' }) { return <span className={`jw-badge jw-badge-${tone}`}>{children}</span>; }
function Button({ children, icon: Icon, tone = '', className = '', ...props }) {
  return <button className={`jw-button ${tone ? `jw-button-${tone}` : ''} ${className}`} {...props}>{Icon && <Icon size={16} aria-hidden="true" />}{children}</button>;
}
function Empty({ icon: Icon = BriefcaseBusiness, title, children, action }) {
  return <div className="jw-empty"><span>{createElement(Icon, { size: 26, strokeWidth: 1.5 })}</span><h3>{title}</h3><p>{children}</p>{action}</div>;
}
function Field({ label, hint, children }) {
  const id = useId();
  return <div className="jw-field"><label htmlFor={id}>{label}</label>{typeof children === 'function' ? children(id) : children}{hint && <small>{hint}</small>}</div>;
}
function Switch({ checked, onChange, label, description, disabled }) {
  return <label className={`jw-switch-row ${disabled ? 'jw-disabled' : ''}`}><span><strong>{label}</strong>{description && <small>{description}</small>}</span><input type="checkbox" checked={Boolean(checked)} onChange={event => onChange(event.target.checked)} disabled={disabled} /><span className="jw-switch" aria-hidden="true" /></label>;
}
function Dialog({ title, children, onClose, wide = false }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement;
    const element = ref.current;
    element.showModal();
    return () => { element.close(); previous?.focus?.(); };
  }, []);
  return <dialog ref={ref} className={`jw-dialog ${wide ? 'jw-dialog-wide' : ''}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div className="jw-dialog-head"><h2 id={titleId}>{title}</h2><Button icon={X} onClick={onClose} aria-label="Close dialog" /></div>{children}</dialog>;
}
function Pager({ page, total, size = 20, onChange, disabled }) {
  return <div className="jw-pager"><span>{number(total)} results · Page {page} of {Math.max(1, Math.ceil(total / size))}</span><div><Button icon={ChevronLeft} disabled={disabled || page <= 1} onClick={() => onChange(page - 1)} aria-label="Previous page" /><Button icon={ChevronRight} disabled={disabled || page * size >= total} onClick={() => onChange(page + 1)} aria-label="Next page" /></div></div>;
}
function Integration({ icon: Icon, name, value, description }) {
  const config = typeof value === 'object' && value !== null ? value : { configured: Boolean(value) };
  const ready = config.ready || config.connected || config.status === 'ready' || config.status === 'connected';
  const configured = config.configured || ready;
  return <div className="jw-integration"><span className="jw-integration-icon">{createElement(Icon, { size: 20 })}</span><div><strong>{name}</strong><small>{description}</small></div><Badge tone={ready ? 'green' : configured ? 'amber' : 'neutral'}>{ready ? 'Connected' : configured ? 'Configured' : 'Setup needed'}</Badge></div>;
}

export default function JobWorkspace() {
  const [tab, setTab] = useState('overview');
  const [mobileMenu, setMobileMenu] = useState(false);
  const [summary, setSummary] = useState({});
  const [status, setStatus] = useState({});
  const [filters, setFilters] = useState(FILTERS);
  const [settings, setSettings] = useState(initialSettings);
  const [profile, setProfile] = useState(initialProfile);
  const [authenticated, setAuthenticated] = useState(hasOwnerKey);
  const [showAccess, setShowAccess] = useState(false);
  const [ownerInput, setOwnerInput] = useState('');
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [jobs, setJobs] = useState([]);
  const [jobsTotal, setJobsTotal] = useState(0);
  const [jobPage, setJobPage] = useState(1);
  const [query, setQuery] = useState('');
  const [jobState, setJobState] = useState('');
  const [selectedJob, setSelectedJob] = useState(null);
  const [directory, setDirectory] = useState([]);
  const [directoryTotal, setDirectoryTotal] = useState(0);
  const [directoryPage, setDirectoryPage] = useState(1);
  const [directoryQuery, setDirectoryQuery] = useState('');
  const [directoryKind, setDirectoryKind] = useState('');
  const [directoryProvider, setDirectoryProvider] = useState('');
  const [directoryCounts, setDirectoryCounts] = useState({});
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState(null);
  const [drafts, setDrafts] = useState([]);
  const [draftModal, setDraftModal] = useState(null);
  const [newDraft, setNewDraft] = useState({ jobId: '', recipient: '', subject: '', body: '' });
  const [showDraftCreate, setShowDraftCreate] = useState(false);
  const [showAddSource, setShowAddSource] = useState(false);
  const [sourceForm, setSourceForm] = useState({ name: '', url: '', kind: 'company', provider: 'manual', country: 'India', board: '' });
  const [showFilters, setShowFilters] = useState(false);
  const [directoryVersion, setDirectoryVersion] = useState(0);
  const [tracking, setTracking] = useState({ state: 'applied', receipt: '', note: '' });
  const jobsRequest = useRef(0);
  const directoryRequest = useRef(0);
  const resumeInput = useRef(null);
  const importInput = useRef(null);
  const profileInput = useRef(null);
  const discoveryPoll = useRef(null);
  const title = NAVIGATION.find(item => item[0] === tab)?.[1] || 'Overview';
  const counts = { ...(summary.counts || {}), ...(status.counts || {}) };
  const preview = isReadOnlyPreview();
  const integrations = status.integrations || summary.integrations || {};
  const runs = asList(summary.runs || status.runs);

  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([automationApi('/summary'), automationApi('/status')]);
    if (results[0].status === 'fulfilled') setSummary(results[0].value);
    if (results[1].status === 'fulfilled') {
      const data = results[1].value;
      setStatus(data);
      if (data.filters || data.settings?.filters) setFilters({ ...FILTERS, ...(data.filters || data.settings.filters) });
      if (data.profile && hasOwnerKey()) setProfile({ ...initialProfile, ...data.profile });
      if (data.settings) setSettings({ ...initialSettings, ...data.settings });
    }
    const failure = results.find(result => result.status === 'rejected');
    if (failure) setError(failure.reason.message);
    else setError('');
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => () => { discoveryPoll.current?.abort(); }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6500);
    return () => clearTimeout(timer);
  }, [notice]);

  const act = async (label, fn) => {
    if (busy) return;
    setBusy(label); setError('');
    try { return await fn(); }
    catch (failure) { setError(failure.message); if (failure.status === 401) { setAuthenticated(false); setShowAccess(true); } }
    finally { setBusy(''); }
  };
  const requireOwner = fn => { if (!authenticated) { setShowAccess(true); return; } return fn(); };

  const loadJobs = useCallback(async (page, search, state, signal) => {
    const sequence = ++jobsRequest.current;
    const params = new URLSearchParams({ page: String(page), limit: '20', search });
    if (state) params.set('state', state);
    try {
      const result = await automationApi(`/jobs?${params}`, { signal });
      if (sequence !== jobsRequest.current) return;
      setJobs(asList(result.items || result.jobs).map(jobData)); setJobsTotal(result.total || 0);
    } catch (failure) { if (failure.name !== 'AbortError' && sequence === jobsRequest.current) setError(failure.message); }
  }, []);
  useEffect(() => {
    if (!authenticated || !['overview', 'jobs', 'applications'].includes(tab)) return;
    const abort = new AbortController();
    const timer = setTimeout(() => void loadJobs(jobPage, query, jobState || (tab === 'applications' ? 'applications' : ''), abort.signal), 250);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [authenticated, jobPage, query, jobState, tab, loadJobs]);
  useEffect(() => {
    if (tab !== 'companies') return;
    const sequence = ++directoryRequest.current;
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ page: String(directoryPage), limit: '20', search: directoryQuery, kind: directoryKind, provider: directoryProvider });
        const result = await automationApi(`/directory?${params}`, { signal: abort.signal });
        if (sequence !== directoryRequest.current) return;
        setDirectory(asList(result.rows || result.items || result.entries)); setDirectoryTotal(result.total || 0); setDirectoryCounts(result.counts || {});
      } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
    }, 250);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [tab, directoryPage, directoryQuery, directoryKind, directoryProvider, directoryVersion]);

  const navigate = next => { setTab(next); setMobileMenu(false); setQuery(''); setJobState(''); setJobPage(1); };
  const unlock = event => {
    event.preventDefault();
    void act('Connecting', async () => {
      setOwnerKey(ownerInput);
      try {
        const result = await automationApi('/profile');
        setProfile({ ...initialProfile, ...(result.profile || result) });
        setAuthenticated(true); setShowAccess(false); setOwnerInput('');
        await refresh();
        const draftResult = await automationApi('/drafts');
        setDrafts(asList(draftResult.items || draftResult.drafts));
        setNotice('Private workspace unlocked for this session.');
      } catch (failure) { setOwnerKey(''); throw failure; }
    });
  };
  const run = () => requireOwner(() => act('Checking sources', async () => {
    const controller = new AbortController(); discoveryPoll.current = controller;
    try {
      const started = await automationApi('/run', { method: 'POST', signal: controller.signal });
      setNotice(started.message || 'Discovery started.'); await refresh();
      if (!started.id) return;
      const deadline = Date.now() + 10 * 60 * 1000;
      let result;
      while (!controller.signal.aborted && Date.now() < deadline) {
        result = await automationApi(`/runs/${encodeURIComponent(started.id)}`, { signal: controller.signal });
        if (!['queued', 'running'].includes(result.state)) break;
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      if (controller.signal.aborted) return;
      await refresh(); await loadJobs(1, '', ''); setJobPage(1);
      if (['failed', 'interrupted'].includes(result?.state)) throw new Error('Discovery could not finish. See recent activity for source failures; saved jobs are retained.');
      if (result?.state !== 'completed') { setNotice('Discovery is still running on the server. Check Recent activity for its final result.'); return; }
      const report = json(result.body);
      setNotice(`Discovery completed: ${number(report.added || 0)} new matches, ${number(report.duplicates || 0)} duplicates, ${number(report.failed || 0)} source failures.`);
    } catch (failure) { if (failure.name !== 'AbortError') throw failure; }
    finally { if (discoveryPoll.current === controller) discoveryPoll.current = null; }
  }));
  const saveFilters = () => requireOwner(() => act('Saving filters', async () => {
    const result = await automationApi('/filters', { method: 'PUT', body: filters });
    setFilters({ ...FILTERS, ...(result.filters || result || filters) }); setNotice('Search preferences saved. New runs will use these filters.'); setShowFilters(false); await refresh();
  }));
  const saveSettings = () => requireOwner(() => act('Saving automation', async () => {
    await automationApi('/settings', { method: 'PUT', body: settings }); setNotice('Automation settings saved.'); await refresh();
  }));
  const saveProfile = event => {
    event.preventDefault(); requireOwner(() => act('Saving profile', async () => {
      const result = await automationApi('/profile', { method: 'PUT', body: profile });
      setProfile({ ...initialProfile, ...(result.profile || result) }); setNotice('Profile saved. Changed details invalidate earlier email approvals.');
    }));
  };
  const uploadResume = event => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
    requireOwner(() => act('Reading résumé', async () => {
      const body = new FormData(); body.append('file', file);
      const result = await automationApi('/resume', { method: 'POST', body });
      setProfile(current => ({ ...current, ...(result.profile || {}), resumeText: result.text || result.resumeText || result.profile?.resumeText || current.resumeText }));
      setNotice('Résumé saved. Review the extracted text; previous email approvals were revoked.');
    }));
  };
  const importProfile = event => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
    requireOwner(() => act('Importing saved profile', async () => {
      let parsed;
      try { parsed = JSON.parse(await file.text()); } catch { throw new Error('Choose a JSON file containing your saved profile.'); }
      const input = parsed.profile || parsed;
      if (!input || Array.isArray(input) || typeof input !== 'object') throw new Error('The profile file must contain an object.');
      const result = await automationApi('/profile', { method: 'PUT', body: input });
      setProfile({ ...initialProfile, ...(result.profile || result) });
      setNotice('Saved profile imported. Review your details and upload the matching résumé.');
    }));
  };
  const toggleSource = row => requireOwner(() => act('Updating source', async () => {
    await automationApi(`/directory/${encodeURIComponent(row.id)}`, { method: 'PATCH', body: { enabled: !row.enabled } });
    setDirectoryVersion(value => value + 1); await refresh();
    setNotice(`${row.name}: automatic discovery ${row.enabled ? 'paused' : 'enabled'}.`);
  }));
  const prepare = job => requireOwner(() => act('Preparing application', async () => {
    const result = await automationApi(`/jobs/${encodeURIComponent(job.id)}/prepare`, { method: 'POST' });
    setNotice(result.message || 'Application package prepared. Check required inputs before applying.');
    if (result.package) downloadJson(result.package, 'application-package.json');
    await loadJobs(jobPage, query, jobState); await refresh(); setSelectedJob(null);
  }));
  const changeState = (job, state) => act('Updating application', async () => {
    await automationApi(`/jobs/${encodeURIComponent(job.id)}`, { method: 'PATCH', body: { state, ...(state === 'applied' ? { receipt: tracking.receipt } : {}), note: tracking.note } });
    setNotice('Application status updated.'); setSelectedJob(null); await loadJobs(jobPage, query, jobState); await refresh();
  });
  const ask = event => {
    event.preventDefault(); requireOwner(() => act('Retrieving evidence', async () => {
      const result = await automationApi('/ask', { method: 'POST', body: { question } }); setAnswer(result);
    }));
  };
  const importDirectory = event => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
    requireOwner(() => act('Importing directory', async () => {
      const content = await file.text();
      let rows;
      try { rows = JSON.parse(content); } catch { throw new Error('Import a JSON array of company or portal records.'); }
      if (!Array.isArray(rows)) rows = rows.rows || rows.items || rows.entries;
      if (!Array.isArray(rows)) throw new Error('The import must contain an array of records.');
      let imported = 0;
      for (let offset = 0; offset < rows.length; offset += 500) {
        const result = await automationApi('/directory/import', { method: 'POST', body: { rows: rows.slice(offset, offset + 500) } });
        imported += Number(result.imported || 0);
      }
      setNotice(`Directory import complete: ${number(imported)} new records added.`); setDirectoryQuery(''); setDirectoryPage(1); setDirectoryVersion(value => value + 1); await refresh();
    }));
  };
  const addSource = event => {
    event.preventDefault(); requireOwner(() => act('Adding source', async () => {
      await automationApi('/directory/import', { method: 'POST', body: { rows: [sourceForm] } });
      setShowAddSource(false); setNotice('Source added. Its health and connection are checked separately.'); setDirectoryQuery(sourceForm.name); setDirectoryPage(1); setDirectoryVersion(value => value + 1); await refresh();
    }));
  };
  const createDraft = event => {
    event.preventDefault(); void act('Creating draft', async () => {
      await automationApi(newDraft.id ? `/drafts/${newDraft.id}` : '/drafts', { method: newDraft.id ? 'PATCH' : 'POST', body: newDraft });
      const result = await automationApi('/drafts'); setDrafts(asList(result.items || result.drafts));
      setShowDraftCreate(false); setNotice('Draft created. Nothing has been emailed.');
    });
  };

  const filterFields = <>
    <div className="jw-filter-title"><h3>Make it your search</h3><Filter size={17} /></div>
    <p className="jw-muted jw-small">Preferences for every discovery run.</p>
    {[['locations', 'Location'], ['keywords', 'Role keywords'], ['skills', 'Priority skills'], ['excludeKeywords', 'Exclude keywords'], ['companies', 'Include companies'], ['excludeCompanies', 'Exclude companies'], ['sources', 'Sources']].map(([key, label]) => <Field key={key} label={label} hint="Separate values with commas">{id => <input id={id} key={asList(filters[key]).join(',')} defaultValue={asList(filters[key]).join(', ')} onBlur={event => setFilters(current => ({ ...current, [key]: split(event.target.value) }))} />}</Field>)}
    <div className="jw-two-fields"><Field label="Minimum CTC (LPA)">{id => <input id={id} type="number" min="0" max="500" value={filters.minSalaryLpa} onChange={event => setFilters(current => ({ ...current, minSalaryLpa: Number(event.target.value) }))} />}</Field><Field label="Experience ceiling">{id => <input id={id} type="number" min="0" max="40" step="0.5" value={filters.maxRequiredYears} onChange={event => setFilters(current => ({ ...current, maxRequiredYears: Number(event.target.value) }))} />}</Field></div>
    <div className="jw-two-fields"><Field label="Posted in last">{id => <select id={id} value={filters.maxAgeDays} onChange={event => setFilters(current => ({ ...current, maxAgeDays: Number(event.target.value) }))}>{[[1, '24 hours'], [2, '48 hours'], [7, '7 days'], [30, '30 days'], [90, '90 days']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>}</Field><Field label="Minimum fit score">{id => <input id={id} type="number" min="0" max="100" value={filters.minMatch} onChange={event => setFilters(current => ({ ...current, minMatch: Number(event.target.value) }))} />}</Field></div>
    <fieldset className="jw-check-group"><legend>Work arrangement</legend>{['onsite', 'hybrid', 'remote'].map(mode => <label key={mode}><input type="checkbox" checked={asList(filters.workModes).includes(mode)} onChange={event => setFilters(current => ({ ...current, workModes: event.target.checked ? [...current.workModes, mode] : current.workModes.filter(item => item !== mode) }))} />{words(mode)}</label>)}</fieldset>
    <Switch checked={filters.includeUnknownSalary} label="Include unpublished salaries" onChange={value => setFilters(current => ({ ...current, includeUnknownSalary: value }))} />
    <Switch checked={filters.includeUnknownExperience} label="Include unspecified experience" onChange={value => setFilters(current => ({ ...current, includeUnknownExperience: value }))} />
    <Switch checked={filters.includeUnknownDate} label="Include unknown posting dates" onChange={value => setFilters(current => ({ ...current, includeUnknownDate: value }))} />
    <Switch checked={filters.verifiedOnly} label="Verified sources only" onChange={value => setFilters(current => ({ ...current, verifiedOnly: value }))} />
    <Button tone="primary" className="jw-full" icon={Check} disabled={Boolean(busy)} onClick={saveFilters}>Save preferences</Button>
  </>;

  const jobCard = job => <article className="jw-job-card" key={job.id}>
    <div className="jw-job-logo" aria-hidden="true">{String(job.company || 'J').slice(0, 2).toUpperCase()}</div>
    <div className="jw-job-content"><div className="jw-job-top"><span className="jw-company-name">{job.company || 'Company not listed'}</span><Badge tone={job.score >= 75 ? 'green' : 'neutral'}>{number(job.score)} fit score</Badge></div><button className="jw-job-title" onClick={() => setSelectedJob(job)}>{job.title || 'Untitled role'}</button><div className="jw-job-meta"><span><MapPin size={13} />{job.location || 'Location not listed'}</span><span><Clock3 size={13} />{job.postedDate ? date(job.postedDate) : 'Posting date unavailable'}</span></div><div className="jw-job-tags">{asList(job.evaluation?.matchedSkills).slice(0, 4).map(skill => <Badge key={skill}>{skill}</Badge>)}<Badge>{words(job.state || 'matched')}</Badge><span>{job.salaryLpa?.min ? `₹${job.salaryLpa.min}${job.salaryLpa.max ? `–${job.salaryLpa.max}` : '+'} LPA` : 'Salary unpublished'}</span></div></div>
    <button className="jw-job-arrow" aria-label={`View ${job.title}`} onClick={() => setSelectedJob(job)}><ArrowUpRight size={20} /></button>
  </article>;

  return <div className="jw-app">
    <a className="jw-skip" href="#workspace-content">Skip to main content</a>
    {mobileMenu && <button className="jw-nav-scrim" onClick={() => setMobileMenu(false)} aria-label="Close navigation" />}
    <aside className={`jw-sidebar ${mobileMenu ? 'jw-sidebar-open' : ''}`}>
      <a href="?workspace=jobs" onClick={event => { event.preventDefault(); navigate('overview'); }} className="jw-brand"><span className="jw-brand-icon"><Leaf size={23} /></span><span>world<span>smart careers</span></span><Badge>beta</Badge></a>
      <div className="jw-workspace-chip"><span className="jw-tiny-dot" /><span>Your career workspace</span></div>
      <span className="jw-nav-eyebrow">WORKSPACE</span>
      <nav aria-label="Main navigation">{NAVIGATION.map(([id, label, Icon]) => <button key={id} className={tab === id ? 'jw-nav-active' : ''} onClick={() => navigate(id)} aria-current={tab === id ? 'page' : undefined}>{createElement(Icon, { size: 19, strokeWidth: 1.7 })}{label}{id === 'applications' && (counts.ready || counts.prepared) > 0 && <small>{number(counts.ready || counts.prepared)}</small>}</button>)}</nav>
      <div className="jw-sidebar-bottom"><div className="jw-quiet-card"><ShieldCheck size={20} /><strong>Your search. Your control.</strong><p>Every email waits for your explicit approval.</p><button onClick={() => navigate('automation')}>Review preferences <ArrowRight size={13} /></button></div><a className="jw-monitor-link" href="?workspace=monitor" onClick={event => { if (!preview) { event.preventDefault(); navigateWorkspace('monitor'); } }}><Globe2 size={17} />World news monitor<ArrowUpRight size={14} /></a><button className="jw-profile-nav" onClick={() => authenticated ? navigate('profile') : setShowAccess(true)}><span><UserRound size={18} /></span><div><strong>{authenticated ? profile.name || 'Your profile' : 'Private workspace'}</strong><small>{authenticated ? 'Session connected' : 'Connect to manage jobs'}</small></div><Settings2 size={16} /></button></div>
    </aside>

    <div className="jw-main">
      <header className="jw-topbar"><div className="jw-breadcrumb"><Button className="jw-mobile-menu" icon={Menu} onClick={() => setMobileMenu(true)} aria-label="Open navigation" /><span>Workspace</span><ChevronRight size={14} /><strong>{title}</strong></div><div className="jw-topbar-actions"><span className="jw-local-date">{new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date())}</span><button className="jw-icon-button" aria-label="View alert settings" onClick={() => navigate('automation')}><Bell size={19} /></button><Button icon={authenticated ? ShieldCheck : LockKeyhole} onClick={() => authenticated ? navigate('profile') : setShowAccess(true)}>{authenticated ? 'Connected' : 'Connect workspace'}</Button></div></header>
      <main className="jw-content" id="workspace-content">
        {preview && <div className="jw-preview-banner" role="status"><CircleHelp size={18} /><span>Read-only preview · Real source directory, no live jobs or connected services. Changes require the application backend.</span></div>}
        {notice && <div className="jw-toast" role="status"><CheckCheck size={19} /><span>{notice}</span><button onClick={() => setNotice(null)} aria-label="Dismiss notification"><X size={16} /></button></div>}
        {error && <div className="jw-error" role="alert"><CircleHelp size={18} /><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><X size={16} /></button></div>}

        {tab === 'overview' && <>
          <div className="jw-page-heading"><div><div className="jw-eyebrow"><span className="jw-tiny-dot" /> A LITTLE DIRECTION. A LOT OF POSSIBILITY.</div><h1>Your next chapter starts here.</h1><p>A calmer, more intentional way to find work that fits you.</p></div><Button tone="primary" icon={RefreshCw} onClick={run} disabled={Boolean(busy)}>{busy === 'Checking sources' ? 'Checking…' : 'Discover jobs'}</Button></div>
          <section className="jw-overview-grid"><div className="jw-hero"><div className="jw-hero-copy"><Badge tone="green"><Sparkles size={12} />Built around you</Badge><h2>Less searching.<br />More possibility.</h2><p>Your preferences, your résumé, and the right sources. One thoughtful workflow from discovery to application.</p><Button tone="dark" icon={ArrowRight} onClick={() => navigate('jobs')}>Explore your matches</Button><div className="jw-hero-foot"><ShieldCheck size={15} />You stay in control of every email.</div></div><div className="jw-hero-art" aria-hidden="true"><div className="jw-orbit jw-orbit-one" /><div className="jw-orbit jw-orbit-two" /><div className="jw-art-leaf"><Leaf size={56} strokeWidth={1} /></div><span className="jw-float jw-float-one"><BriefcaseBusiness size={20} /></span><span className="jw-float jw-float-two"><Sparkles size={19} /></span><span className="jw-float jw-float-three"><Check size={20} /></span><div className="jw-art-caption"><span className="jw-tiny-dot" />A better fit, by design</div></div></div><div className="jw-search-profile"><div className="jw-section-title"><h3>Your search at a glance</h3><button onClick={() => navigate('profile')} aria-label="Edit profile"><Settings2 size={17} /></button></div><div className="jw-profile-line"><MapPin size={17} /><div><small>Preferred location</small><strong>{asList(filters.locations).join(', ') || 'Any location'}</strong></div></div><div className="jw-profile-line"><BriefcaseBusiness size={17} /><div><small>Target compensation</small><strong>₹{filters.minSalaryLpa || 0} LPA and above</strong></div></div><div className="jw-profile-line"><Clock3 size={17} /><div><small>Notice period</small><strong>{profile.noticeDays || 60} days</strong></div></div><div className="jw-profile-line"><Workflow size={17} /><div><small>Automation</small><strong>{settings.enabled ? `Every ${settings.intervalMinutes} minutes` : 'Paused · run when ready'}</strong></div></div><button className="jw-text-link" onClick={() => navigate('automation')}>Fine-tune your workflow <ArrowRight size={14} /></button></div></section>
          <section className="jw-metric-grid" aria-label="Workspace metrics">{[[BriefcaseBusiness, 'Matched opportunities', counts.jobs ?? counts.matched ?? 0, 'Saved matches, after your filters'], [FileText, 'Applications prepared', counts.ready ?? counts.prepared ?? 0, 'Ready for your next step'], [Bell, 'Alerts delivered', status.alerts?.sent ?? 0, 'Recorded Slack deliveries'], [Building2, 'Directory records', counts.directory ?? 0, 'Actual imported companies and portals']].map(([Icon, label, value, detail]) => <div className="jw-metric" key={label}><div><span>{label}</span>{createElement(Icon, { size: 18 })}</div><strong>{loading ? '—' : number(value)}</strong><small>{detail}</small></div>)}</section>
          <section className="jw-dashboard-lower"><div className="jw-panel"><div className="jw-section-title"><div><h2>Opportunities, with intention</h2><p>Your latest saved matches.</p></div><button className="jw-text-link" onClick={() => navigate('jobs')}>View all <ArrowRight size={14} /></button></div>{authenticated && jobs.length ? <div className="jw-job-list">{jobs.slice(0, 3).map(jobCard)}</div> : <Empty title={authenticated ? 'A fresh start for your search' : 'Your matches are private'}>{authenticated ? 'Save your profile, choose your filters, and run discovery to populate your workspace.' : 'Connect your private workspace to see matches and manage applications.'}</Empty>}</div><div className="jw-panel jw-flow-panel"><div className="jw-section-title"><h2>From discovery to next step</h2><Workflow size={18} /></div><ol className="jw-workflow-list">{[['Discover', 'Read enabled, supported career sources.'], ['Match', 'Filter and rank against résumé evidence.'], ['Review', 'Keep clear reasons, gaps, and source links.'], ['Prepare', 'Build an application package with your details.'], ['Approve', 'Send emails only after your explicit approval.']].map(([label, description], index) => <li key={label}><span>{index + 1}</span><div><strong>{label}</strong><p>{description}</p></div></li>)}</ol><button className="jw-text-link" onClick={() => navigate('automation')}>Open automation <ArrowRight size={14} /></button></div></section>
        </>}

        {(tab === 'jobs' || tab === 'applications') && <>
          <div className="jw-page-heading"><div><div className="jw-eyebrow">{tab === 'jobs' ? 'THE RIGHT WORK, FOR YOU' : 'YOUR NEXT STEPS'}</div><h1>{tab === 'jobs' ? 'Find your next opportunity.' : 'Keep every application in view.'}</h1><p>{tab === 'jobs' ? 'Relevant openings, clear evidence, and room for your judgment.' : 'Preparation, review, and progress in one place. Submitted means a confirmed receipt.'}</p></div><Button tone="primary" icon={tab === 'jobs' ? RefreshCw : Mail} disabled={Boolean(busy)} onClick={tab === 'jobs' ? run : () => requireOwner(() => { setNewDraft({ jobId: jobs[0]?.id || '', recipient: '', subject: '', body: '' }); setShowDraftCreate(true); })}>{tab === 'jobs' ? 'Discover jobs' : 'Create email draft'}</Button></div>
          {!authenticated ? <section className="jw-panel"><Empty icon={LockKeyhole} title="A private space for your next move" action={<Button tone="primary" onClick={() => setShowAccess(true)}>Connect workspace</Button>}>Your résumé, matches, and application details are protected by your workspace key.</Empty></section> : <div className={`jw-jobs-layout ${tab === 'applications' ? 'jw-jobs-layout-wide' : ''}`}>
            {tab === 'jobs' && <aside className="jw-filters-panel">{filterFields}</aside>}
            <div><div className="jw-list-toolbar"><div className="jw-search"><Search size={17} /><input aria-label="Search jobs" placeholder="Search a role, company, or skill…" value={query} onChange={event => { setQuery(event.target.value); setJobPage(1); }} /></div><select aria-label="Filter by application status" value={jobState} onChange={event => { setJobState(event.target.value); setJobPage(1); }}><option value="">{tab === 'applications' ? 'All applications' : 'All statuses'}</option>{['matched', 'review', 'ready', 'needs_input', 'applied', 'interview', 'offer', 'closed', 'archived'].map(state => <option key={state} value={state}>{words(state)}</option>)}</select>{tab === 'jobs' && <Button className="jw-filter-mobile" icon={Filter} onClick={() => setShowFilters(true)}>Filters</Button>}</div><div className="jw-result-heading"><span><strong>{number(jobsTotal)}</strong> saved opportunities</span><span>Fit scores reflect résumé evidence</span></div><div className="jw-job-list">{jobs.length ? jobs.map(jobCard) : <div className="jw-panel"><Empty title={query || jobState ? 'No matches for these filters' : 'Your opportunities will appear here'}>{query || jobState ? 'Try a different search or status. Your discovery preferences are saved separately.' : 'Run discovery after saving your profile and enabling supported career sources.'}</Empty></div>}</div><Pager page={jobPage} total={jobsTotal} onChange={setJobPage} />
              {tab === 'applications' && <section className="jw-panel jw-drafts-panel"><div className="jw-section-title"><div><h2>Email approval inbox</h2><p>Review the exact recipient and message before approving.</p></div><Badge tone="green"><ShieldCheck size={12} />Approval required</Badge></div>{drafts.length ? drafts.map(draft => <button key={draft.id} className="jw-draft-row" onClick={() => setDraftModal(draft)}><Mail size={18} /><div><strong>{draft.subject}</strong><span>{draft.recipient}</span></div><Badge>{words(draft.state)}</Badge><ChevronRight size={16} /></button>) : <Empty icon={Mail} title="No email drafts yet">Drafts stay here until you review and approve them. Automatic preparation never authorizes email delivery.</Empty>}</section>}
            </div>
          </div>}
        </>}

        {tab === 'companies' && <>
          <div className="jw-page-heading"><div><div className="jw-eyebrow">A WIDER WORLD OF WORK</div><h1>Great companies. Clear sources.</h1><p>Search the directory and manage the career portals behind your discovery.</p></div><div className="jw-actions"><Button icon={Upload} onClick={() => requireOwner(() => importInput.current?.click())}>Import records</Button><Button tone="primary" icon={Building2} onClick={() => requireOwner(() => setShowAddSource(true))}>Add source</Button><input className="jw-hidden" ref={importInput} type="file" accept="application/json,.json" onChange={importDirectory} /></div></div>
          <div className="jw-capacity-banner"><Database size={22} /><div><strong>{number(directoryCounts.total ?? counts.directory ?? directoryTotal)} imported records</strong><p>Capacity: 100,000 company records and 10,000 career portals. Capacity is separate from verified coverage.</p></div><Badge tone="green">Actual counts, always</Badge></div>
          <section className="jw-panel"><div className="jw-list-toolbar"><div className="jw-search"><Search size={17} /><input aria-label="Search company directory" placeholder="Search companies and career portals…" value={directoryQuery} onChange={event => { setDirectoryQuery(event.target.value); setDirectoryPage(1); }} /></div><select aria-label="Directory record type" value={directoryKind} onChange={event => { setDirectoryKind(event.target.value); setDirectoryPage(1); }}><option value="">All records</option><option value="company">Companies</option><option value="portal">Career portals</option></select><select aria-label="Career platform" value={directoryProvider} onChange={event => { setDirectoryProvider(event.target.value); setDirectoryPage(1); }}><option value="">All platforms</option>{['greenhouse', 'lever', 'ashby', 'workday', 'manual'].map(provider => <option key={provider} value={provider}>{words(provider)}</option>)}</select></div><div className="jw-table-wrap"><table className="jw-table"><thead><tr><th>Company / portal</th><th>Platform</th><th>Health</th><th>Discovery</th><th>Jobs seen</th><th>Last checked</th><th><span className="jw-sr-only">Career page</span></th></tr></thead><tbody>{directory.map(row => <tr key={row.id || row.url}><td><div className="jw-table-company"><span>{String(row.name).slice(0, 2).toUpperCase()}</span><div><strong>{row.name}</strong><small>{row.country || 'Global'} · {words(row.kind)}</small></div></div></td><td><Badge>{row.provider || 'manual'}</Badge></td><td><Badge tone={['healthy', 'active', 'ok'].includes(row.status) ? 'green' : row.status === 'error' ? 'amber' : 'neutral'}>{words(row.status || 'unverified')}</Badge></td><td>{['greenhouse', 'lever', 'ashby'].includes(row.provider) ? <Button onClick={() => toggleSource(row)} disabled={Boolean(busy)} aria-label={`${row.enabled ? 'Pause' : 'Enable'} ${row.name} discovery`}>{row.enabled ? 'Enabled' : 'Paused'}</Button> : <span>Directory only</span>}</td><td>{number(row.job_count ?? row.jobCount ?? 0)}</td><td>{date(row.checked_at || row.checkedAt)}</td><td>{safeLink(row.url) && <a className="jw-icon-button" aria-label={`Open ${row.name} careers`} href={safeLink(row.url)} target="_blank" rel="noreferrer"><ArrowUpRight size={17} /></a>}</td></tr>)}</tbody></table></div>{!directory.length && <Empty icon={Building2} title="No directory records found">Try another query, or import real company records with their official career URLs.</Empty>}<Pager page={directoryPage} total={directoryTotal} onChange={setDirectoryPage} /></section>
          <div className="jw-inline-note"><CircleHelp size={16} /><p>Supported ATS sources can be fetched automatically. Other career URLs remain useful directory links until an adapter is available. Import JSON with name, url, kind, provider, board, country, and sector.</p></div>
        </>}

        {tab === 'research' && <>
          <div className="jw-page-heading"><div><div className="jw-eyebrow">EVIDENCE BEFORE ASSUMPTIONS</div><h1>A clearer picture of your fit.</h1><p>Ask questions grounded in your résumé and discovered jobs, with sources you can inspect.</p></div><Button icon={Database} disabled={Boolean(busy)} onClick={() => requireOwner(() => act('Indexing evidence', async () => { const result = await automationApi('/reindex', { method: 'POST' }); setNotice(result.status === 'not_configured' ? 'Qdrant is not configured. Add its cluster URL and API key on the server.' : result.message || `Indexed ${number(result.indexed || 0)} job evidence records.`); await refresh(); }))}>Refresh index</Button></div>
          <div className="jw-research-grid"><section className="jw-panel jw-research-panel"><div className="jw-research-welcome"><span><Sparkles size={29} strokeWidth={1.5} /></span><h2>What would you like to understand?</h2><p>Compare role requirements, find evidence in your résumé, or identify the gaps worth working on.</p></div><div className="jw-prompts">{['Which roles fit my Python and agentic AI experience?', 'What skills appear most often in my matched roles?', 'What evidence in my résumé supports my strongest matches?'].map(prompt => <button key={prompt} onClick={() => setQuestion(prompt)}>{prompt}<ArrowUpRight size={14} /></button>)}</div><form onSubmit={ask} className="jw-question-form"><label htmlFor="jw-question" className="jw-sr-only">Research question</label><textarea id="jw-question" value={question} onChange={event => setQuestion(event.target.value)} placeholder="Ask about your opportunities…" rows={3} required maxLength={2000} /><div><span><BookOpen size={14} />Answers backed by retrieved evidence</span><Button tone="primary" icon={Send} type="submit" disabled={Boolean(busy) || !question.trim()}>{busy === 'Retrieving evidence' ? 'Searching…' : 'Ask'}</Button></div></form>{answer && <div className="jw-research-answer"><div className="jw-section-title"><h3>What the evidence says</h3><Badge>{answer.retrieval || answer.mode || answer.provider || 'Evidence retrieval'}</Badge></div><p>{answer.answer || answer.message || 'No supported answer was returned. Try a more specific question.'}</p><div className="jw-evidence">{asList(answer.sources || answer.evidence || answer.documents).map((source, index) => <article key={source.id || index}><strong>[{source.id || index + 1}] {source.title || 'Retrieved evidence'}</strong><p>{source.text || source.content || source.excerpt || source.snippet}</p>{safeLink(source.url) && <a href={safeLink(source.url)} target="_blank" rel="noreferrer">View source <ExternalLink size={12} /></a>}</article>)}</div></div>}</section><aside className="jw-panel"><h3>Your intelligence stack</h3><p className="jw-muted jw-small">Optional services enhance a functional retrieval baseline.</p><Integration icon={Database} name="Qdrant" value={integrations.qdrant} description="Sparse keyword evidence retrieval" /><Integration icon={Bot} name="Jev" value={integrations.jev} description="Structured fit decisions" /><Integration icon={Sparkles} name="Answer model" value={integrations.model || integrations.llm} description="Grounded answer generation" /><div className="jw-inline-note"><ShieldCheck size={17} /><p>Model output is advisory. It never grants permission to send an email or invents application facts.</p></div></aside></div>
        </>}

        {tab === 'profile' && <>
          <div className="jw-page-heading"><div><div className="jw-eyebrow">THE STORY BEHIND THE SEARCH</div><h1>Make it a personal fit.</h1><p>Your verified details help prepare accurate applications. Only add skills and experience you can support.</p></div>{authenticated && <Button icon={LockKeyhole} onClick={() => { setOwnerKey(''); setAuthenticated(false); setProfile(initialProfile); setJobs([]); setDrafts([]); setAnswer(null); setStatus({}); setSettings(initialSettings); setFilters(FILTERS); setSelectedJob(null); setDraftModal(null); setNotice('Workspace locked. The session key was cleared.'); }}>Lock workspace</Button>}</div>
          {!authenticated ? <section className="jw-panel"><Empty icon={LockKeyhole} title="Your profile stays private" action={<Button tone="primary" onClick={() => setShowAccess(true)}>Connect workspace</Button>}>Unlock this session to edit your résumé and application details.</Empty></section> : <form onSubmit={saveProfile} className="jw-profile-layout"><section className="jw-panel"><div className="jw-section-title"><div><h2>Your application details</h2><p>Saved privately on your backend.</p></div><Badge tone="green"><LockKeyhole size={12} />Private</Badge></div><div className="jw-form-grid">{[['name', 'Full name'], ['email', 'Email address', 'email'], ['phone', 'Phone number', 'tel'], ['city', 'Current city'], ['currentEmployer', 'Current employer'], ['experienceYears', 'Professional experience (years)', 'number'], ['noticeDays', 'Official notice period (days)', 'number'], ['currentCtcLpa', 'Current CTC (LPA)', 'number'], ['expectedCtcLpa', 'Expected CTC (LPA)', 'number'], ['minimumCtcLpa', 'Minimum CTC (LPA)', 'number'], ['linkedin', 'LinkedIn URL', 'url'], ['github', 'GitHub URL', 'url'], ['leetcode', 'LeetCode URL', 'url'], ['portfolio', 'Portfolio URL', 'url'], ['workAuthorization', 'Work authorization']].map(([key, label, type = 'text']) => <Field key={key} label={label}>{id => <input id={id} type={type} value={profile[key] ?? ''} min={type === 'number' ? 0 : undefined} step={type === 'number' ? 'any' : undefined} required={['name', 'email'].includes(key)} onChange={event => setProfile(current => ({ ...current, [key]: type === 'number' && event.target.value !== '' ? Number(event.target.value) : event.target.value }))} />}</Field>)}</div><Field label="Skills" hint="Comma-separated; keep these consistent with your résumé.">{id => <input id={id} key={asList(profile.skills).join(',')} defaultValue={asList(profile.skills).join(', ')} onBlur={event => setProfile(current => ({ ...current, skills: split(event.target.value) }))} />}</Field><Switch label="Willing to relocate" description="For roles within your preferred locations." checked={profile.willingToRelocate} onChange={value => setProfile(current => ({ ...current, willingToRelocate: value }))} /><div className="jw-form-footer"><span><ShieldCheck size={15} />Email always requires explicit approval.</span><Button tone="primary" icon={Check} type="submit" disabled={Boolean(busy)}>Save profile</Button></div></section><aside className="jw-panel"><h2>Your résumé</h2><p className="jw-muted">Use your résumé as the source of truth for matching and preparation.</p><Button type="button" className="jw-import-profile" icon={Upload} onClick={() => profileInput.current?.click()} disabled={Boolean(busy)}>Import saved profile</Button><input className="jw-hidden" ref={profileInput} type="file" accept="application/json,.json" onChange={importProfile} /><button type="button" className="jw-upload-zone" onClick={() => resumeInput.current?.click()} disabled={Boolean(busy)}><Upload size={27} /><strong>Upload your résumé</strong><span>PDF, DOCX, or text · up to 8 MB</span></button><input className="jw-hidden" ref={resumeInput} type="file" accept=".pdf,.docx,.txt" onChange={uploadResume} /><Field label="Résumé evidence" hint="Review the extracted text before saving.">{id => <textarea id={id} rows={17} value={profile.resumeText || ''} onChange={event => setProfile(current => ({ ...current, resumeText: event.target.value }))} />}</Field><div className="jw-inline-note"><FileText size={16} /><p>No invented qualifications. Missing required answers are flagged for you to complete.</p></div></aside></form>}
        </>}

        {tab === 'automation' && <>
          <div className="jw-page-heading"><div><div className="jw-eyebrow">A ROUTINE THAT WORKS FOR YOU</div><h1>Let the right work find you.</h1><p>Set your pace, connect your services, and see exactly what each run did.</p></div><Button tone="primary" icon={Play} onClick={run} disabled={Boolean(busy)}>Run discovery now</Button></div>
          <div className="jw-automation-grid"><section className="jw-panel"><div className="jw-section-title"><h2>Discovery workflow</h2><Badge tone={settings.enabled ? 'green' : 'neutral'}>{settings.enabled ? 'Scheduled' : 'Paused'}</Badge></div><Switch label="Scheduled discovery" description="Runs on the backend while the service is online." checked={settings.enabled} onChange={value => setSettings(current => ({ ...current, enabled: value }))} /><Field label="Check for new opportunities">{id => <select id={id} value={settings.intervalMinutes} onChange={event => setSettings(current => ({ ...current, intervalMinutes: Number(event.target.value) }))}>{[[15, 'Every 15 minutes'], [30, 'Every 30 minutes'], [60, 'Every hour'], [180, 'Every 3 hours'], [360, 'Every 6 hours'], [1440, 'Daily']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>}</Field><fieldset className="jw-mode-options"><legend>Application preparation</legend>{[['RM', 'Review mode', 'Keep new matches in your queue to inspect before preparation.'], ['AA', 'Auto prepare', 'Prepare matching applications with saved facts. Handle logins, CAPTCHA, and final submission separately.']].map(([value, label, description]) => <label key={value} className={settings.mode === value ? 'jw-mode-selected' : ''}><input type="radio" name="mode" value={value} checked={settings.mode === value} onChange={() => setSettings(current => ({ ...current, mode: value }))} /><span><strong>{label}</strong><small>{description}</small></span></label>)}</fieldset><Switch label="Slack job alerts" description="Queue one alert per new matching job. Delivery requires a configured Slack connection." checked={settings.slackEnabled} onChange={value => setSettings(current => ({ ...current, slackEnabled: value }))} /><Field label="Sources checked per run" hint="Bounded batches keep discovery manageable.">{id => <input id={id} type="number" min="1" max="200" value={settings.sourcesPerRun} onChange={event => setSettings(current => ({ ...current, sourcesPerRun: Number(event.target.value) }))} />}</Field><Switch label="Use Qdrant retrieval" description="Index public job evidence when the server connection is configured." checked={settings.useQdrant} onChange={value => setSettings(current => ({ ...current, useQdrant: value }))} /><Switch label="Use Jev decisions" description="Add bounded structured fit evaluations when a TypeSafe key is configured." checked={settings.useJev} onChange={value => setSettings(current => ({ ...current, useJev: value }))} /><div className="jw-approval-note"><ShieldCheck size={20} /><div><strong>Email approval is always on</strong><p>Review the exact recipient, message, and résumé before sending. Profile or draft changes invalidate previous approvals.</p></div></div><Button tone="primary" icon={Check} onClick={saveSettings} disabled={Boolean(busy)}>Save workflow</Button></section><section className="jw-panel"><div className="jw-section-title"><h2>Connected services</h2><Settings2 size={17} /></div><Integration icon={Bell} name="Slack" value={integrations.slack} description="New matching job notifications" /><Integration icon={Database} name="Qdrant" value={integrations.qdrant} description="Sparse keyword search over job evidence" /><Integration icon={Bot} name="Jev" value={integrations.jev} description="Structured decisions with confidence" /><Integration icon={Sparkles} name="Answer model" value={integrations.model || integrations.llm} description="Grounded research and explanations" /><Integration icon={Mail} name="Email transport" value={integrations.email} description="User-approved messages only" /><div className="jw-inline-note"><LockKeyhole size={17} /><p>Service credentials are configured on the server. Keys are never placed in the frontend bundle or public repository.</p></div><details className="jw-setup-details"><summary>Connection requirements</summary><p>Qdrant needs a cluster URL and API key. The current integration uses sparse keyword retrieval; a dense embedding model is not required. Slack needs a bot token and destination channel. Jev needs a TypeSafe API key. A credential alone does not verify a live connection. Secret values should be set in environment variables on the backend.</p></details></section></div>
          <section className="jw-panel jw-activity-panel"><div className="jw-section-title"><div><h2>Recent activity</h2><p>Recorded runs and their outcomes.</p></div><Button icon={RefreshCw} onClick={refresh}>Refresh</Button></div>{runs.length ? runs.slice(0, 10).map(runItem => { const details = json(runItem.body); return <div className="jw-activity-row" key={runItem.id}><span className="jw-activity-icon"><Activity size={17} /></span><div><strong>{words(runItem.state || 'discovery')}</strong><small>{date(runItem.started_at || runItem.startedAt)}</small></div><span>{details.matched != null ? `${number(details.matched)} matches` : details.message || 'Run details recorded'}</span><Badge>{runItem.finished_at || runItem.finishedAt ? 'Finished' : words(runItem.state)}</Badge></div>; }) : <Empty icon={Activity} title="A clean activity log">Run discovery to see checked sources, matches, and delivery outcomes here.</Empty>}</section>
        </>}
        <footer className="jw-footer"><span><Leaf size={13} />World Smart Careers</span><span>Designed for a more intentional next step.</span><button onClick={() => navigate('automation')}>Workflow & privacy <ArrowUpRight size={12} /></button></footer>
      </main>
    </div>

    {showAccess && <Dialog title="Connect your private workspace" onClose={() => { setShowAccess(false); setOwnerInput(''); }}><form onSubmit={unlock}><p className="jw-muted">Enter the owner access key configured on your backend. It is kept in memory for this browser session only.</p><Field label="Workspace access key">{id => <input id={id} type="password" autoComplete="off" value={ownerInput} onChange={event => setOwnerInput(event.target.value)} required autoFocus />}</Field><div className="jw-dialog-actions"><Button type="button" onClick={() => { setShowAccess(false); setOwnerInput(''); }}>Cancel</Button><Button tone="primary" type="submit" icon={LockKeyhole} disabled={preview || Boolean(busy) || !ownerInput.trim()}>Connect workspace</Button></div></form></Dialog>}
    {showFilters && <Dialog title="Search preferences" onClose={() => setShowFilters(false)}>{filterFields}</Dialog>}
    {selectedJob && <Dialog title={selectedJob.title} onClose={() => setSelectedJob(null)} wide><div className="jw-job-detail"><div className="jw-detail-meta"><span><Building2 size={16} />{selectedJob.company}</span><span><MapPin size={16} />{selectedJob.location}</span><Badge tone="green">{number(selectedJob.score)} fit score</Badge></div><p className="jw-job-description">{selectedJob.description || 'Open the original listing to read the complete requirements.'}</p><h3>Evidence & review notes</h3><div className="jw-job-tags">{asList(selectedJob.evaluation?.matchedSkills).map(skill => <Badge key={skill} tone="green">{skill}</Badge>)}</div>{asList(selectedJob.evaluation?.reasons || selectedJob.evaluation?.gaps).length ? <ul>{asList(selectedJob.evaluation.reasons || selectedJob.evaluation.gaps).map((reason, index) => <li key={index}>{String(reason)}</li>)}</ul> : <p className="jw-muted">Review the source requirements and your saved profile before applying.</p>}<div className="jw-inline-note"><CircleHelp size={16} /><p>Fit scores measure matching evidence, not hiring likelihood. Unpublished compensation is not guaranteed to meet your target.</p></div><details className="jw-setup-details"><summary>Record application progress</summary><Field label="Application status">{id => <select id={id} value={tracking.state} onChange={event => setTracking(current => ({ ...current, state: event.target.value }))}>{['review', 'applied', 'interview', 'offer'].map(value => <option key={value} value={value}>{value}</option>)}</select>}</Field>{tracking.state === 'applied' && <Field label="Employer confirmation / receipt" hint="Required before recording a submitted application.">{id => <input id={id} value={tracking.receipt} onChange={event => setTracking(current => ({ ...current, receipt: event.target.value }))} />}</Field>}<Field label="Private note">{id => <textarea id={id} rows={2} value={tracking.note} onChange={event => setTracking(current => ({ ...current, note: event.target.value }))} />}</Field><Button onClick={() => changeState(selectedJob, tracking.state)} disabled={Boolean(busy) || (tracking.state === 'applied' && !tracking.receipt.trim())}>Record progress</Button></details><div className="jw-dialog-actions">{safeLink(selectedJob.url) && <a className="jw-button" href={safeLink(selectedJob.url)} target="_blank" rel="noreferrer"><ExternalLink size={16} />Official listing</a>}<Button disabled={Boolean(busy)} onClick={() => changeState(selectedJob, 'archived')}>Archive</Button><Button icon={Mail} onClick={() => { setNewDraft({ jobId: selectedJob.id, recipient: '', subject: `Application for ${selectedJob.title}`, body: '' }); setSelectedJob(null); setShowDraftCreate(true); }}>Draft email</Button><Button tone="primary" icon={FileText} disabled={Boolean(busy)} onClick={() => prepare(selectedJob)}>Prepare application</Button></div></div></Dialog>}
    {showAddSource && <Dialog title="Add a career source" onClose={() => setShowAddSource(false)}><form onSubmit={addSource}><p className="jw-muted">Use the company’s official careers page or a supported ATS board. A directory entry does not imply a verified connection.</p>{[['name', 'Company / portal name'], ['url', 'Official HTTPS career URL'], ['board', 'ATS board identifier'], ['country', 'Country']].map(([key, label]) => <Field key={key} label={label}>{id => <input id={id} type={key === 'url' ? 'url' : 'text'} value={sourceForm[key]} required={['name', 'url'].includes(key)} onChange={event => setSourceForm(current => ({ ...current, [key]: event.target.value }))} />}</Field>)}<div className="jw-two-fields"><Field label="Record type">{id => <select id={id} value={sourceForm.kind} onChange={event => setSourceForm(current => ({ ...current, kind: event.target.value }))}><option value="company">Company</option><option value="portal">Portal</option></select>}</Field><Field label="Platform">{id => <select id={id} value={sourceForm.provider} onChange={event => setSourceForm(current => ({ ...current, provider: event.target.value }))}>{['manual', 'greenhouse', 'lever', 'ashby'].map(provider => <option value={provider} key={provider}>{provider}</option>)}</select>}</Field></div><div className="jw-dialog-actions"><Button onClick={() => setShowAddSource(false)} type="button">Cancel</Button><Button tone="primary" type="submit" disabled={Boolean(busy)}>Add source</Button></div></form></Dialog>}
    {showDraftCreate && <Dialog title="Prepare an email draft" onClose={() => setShowDraftCreate(false)} wide><form onSubmit={createDraft}><p className="jw-muted">Creating a draft does not send anything. Review and approval happen separately.</p><Field label="Job this email is for">{id => <select id={id} value={newDraft.jobId || ''} required disabled={Boolean(newDraft.id)} onChange={event => setNewDraft(current => ({ ...current, jobId: event.target.value }))}><option value="">Select a saved job</option>{newDraft.id && !jobs.some(job => job.id === newDraft.jobId) && <option value={newDraft.jobId}>Saved application</option>}{jobs.map(job => <option key={job.id} value={job.id}>{job.company} — {job.title}</option>)}</select>}</Field><Field label="Recipient">{id => <input id={id} type="email" value={newDraft.recipient} onChange={event => setNewDraft(current => ({ ...current, recipient: event.target.value }))} required />}</Field><Field label="Subject">{id => <input id={id} value={newDraft.subject} onChange={event => setNewDraft(current => ({ ...current, subject: event.target.value }))} required />}</Field><Field label="Message">{id => <textarea id={id} rows={10} value={newDraft.body} onChange={event => setNewDraft(current => ({ ...current, body: event.target.value }))} required />}</Field><div className="jw-dialog-actions"><Button type="button" onClick={() => setShowDraftCreate(false)}>Cancel</Button><Button tone="primary" type="submit" disabled={Boolean(busy)}>Save unsent draft</Button></div></form></Dialog>}
    {draftModal && <Dialog title="Review this email" onClose={() => setDraftModal(null)} wide><div className="jw-draft-preview"><p><strong>To:</strong> {draftModal.recipient}</p><p><strong>Subject:</strong> {draftModal.subject}</p><p className="jw-pre-wrap">{draftModal.body}</p><Badge>{words(draftModal.state)}</Badge><p className="jw-muted jw-small">Résumé attachment: {profile.resumeHash === draftModal.resume_hash ? profile.resumeName || 'Uploaded résumé' : 'An earlier résumé version'} · Profile revision {draftModal.profile_revision}.</p><Button onClick={() => act('Downloading résumé', () => downloadPrivateFile('/resume', profile.resumeName || 'resume'))} disabled={profile.resumeHash !== draftModal.resume_hash}>Review attached résumé</Button><p className="jw-muted jw-small">Approval covers this exact content and profile revision. Any change requires a fresh approval.</p><div className="jw-dialog-actions"><Button icon={ArrowDownToLine} onClick={() => act('Downloading draft', () => downloadPrivateFile(`/drafts/${draftModal.id}/download`, 'application-email-draft.eml'))}>Download email</Button>{['draft', 'stale', 'approved'].includes(draftModal.state) && <Button onClick={() => { setNewDraft({ ...draftModal, jobId: draftModal.job_id }); setDraftModal(null); setShowDraftCreate(true); }}>Edit draft</Button>}{draftModal.state === 'draft' && <Button tone="primary" icon={Check} disabled={Boolean(busy)} onClick={() => act('Approving draft', async () => { const result = await automationApi(`/drafts/${draftModal.id}/approve`, { method: 'POST', body: { digest: draftModal.digest } }); setDraftModal(result.draft || { ...draftModal, state: 'approved' }); setNotice('This exact draft is approved. Use Send to deliver it.'); })}>Approve this exact email</Button>}{draftModal.state === 'approved' && <Button tone="primary" icon={Send} disabled={Boolean(busy)} onClick={() => act('Sending approved email', async () => { const result = await automationApi(`/drafts/${draftModal.id}/send`, { method: 'POST', body: { digest: draftModal.digest } }); if (result.state !== 'sent' || !result.receipt) throw new Error('Delivery has no confirmed receipt. Check its status before attempting another send.'); setDraftModal(result.draft || { ...draftModal, state: 'sent', receipt: result.receipt }); setNotice('Email transport returned a delivery receipt.'); const refreshed = await automationApi('/drafts'); setDrafts(asList(refreshed.items || refreshed.drafts)); })}>Send approved email</Button>}</div></div></Dialog>}
  </div>;
}
