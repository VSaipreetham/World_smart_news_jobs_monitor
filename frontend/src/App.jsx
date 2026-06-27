import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Globe from 'react-globe.gl';
import {
  Activity,
  ArrowUpRight,
  Bot,
  Briefcase,
  Building2,
  Clock3,
  Cloud,
  Compass,
  Cpu,
  Database,
  ExternalLink,
  Filter,
  Globe2,
  Layers,
  MapPin,
  Newspaper,
  Play,
  RefreshCcw,
  Route,
  Search,
  ShieldCheck,
  Server,
  Sparkles,
  Target,
  TrendingUp,
  Upload,
  Video,
  Zap,
  X,
} from 'lucide-react';
import './App.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
const FEED_LIMIT = 80;
const PORTAL_LIMIT = 18;

const API_BASES = [
  API_BASE,
  API_BASE ? '' : null,
  import.meta.env.DEV ? 'http://127.0.0.1:8000' : null,
].filter((base, index, items) => base !== null && items.indexOf(base) === index);

function apiUrl(path, base = API_BASES[0] || '') {
  return `${base}${path}`;
}

async function apiFetch(path, options) {
  let lastResponse = null;
  let lastError = null;
  for (const base of API_BASES) {
    try {
      const response = await fetch(apiUrl(path, base), options);
      if (response.ok) return response;
      lastResponse = response;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastResponse) return lastResponse;
  throw lastError || new Error('api_unavailable');
}

function formatAge(seconds) {
  if (seconds == null) return 'waiting';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function formatDateAge(value) {
  if (!value) return 'fresh check';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  return formatAge(seconds);
}

function normalizeVideos(videos = []) {
  return videos
    .map((video) => ({
      ...video,
      videoId: video.videoId || video.video_id,
    }))
    .filter((video) => video.videoId);
}

function Metric({ icon: Icon, label, value, tone = 'default' }) {
  return (
    <div className={`metric ${tone}`}>
      <Icon size={17} />
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function EmptyState({ title }) {
  return <div className="empty-state">{title}</div>;
}

function SkeletonRows({ count = 4, media = false }) {
  return Array.from({ length: count }, (_, index) => (
    <div className={`skeleton-row ${media ? 'media' : ''}`} key={`skeleton-${index}`}>
      {media && <span className="skeleton-thumb" />}
      <span>
        <i />
        <em />
      </span>
    </div>
  ));
}

function cleanModelLabel(value) {
  if (!value) return 'offline';
  return String(value)
    .replace(':free', '')
    .replace(/^openrouter\//, '')
    .replace(/^google\//, '')
    .replace(/^openai\//, '')
    .replace(/^meta-llama\//, '')
    .replace(/^qwen\//, '')
    .replace(/^nvidia\//, '')
    .replace(/^cohere\//, '');
}

function AiBadge({ meta, label = 'AI' }) {
  const provider = meta?.provider || 'Deterministic';
  const model = cleanModelLabel(meta?.model || meta?.modelName);
  return (
    <div className={`ai-badge ${meta?.fallback ? 'fallback' : ''}`}>
      <Bot size={13} />
      <span>{label}</span>
      <strong>{provider} / {model}</strong>
      {meta?.fallback && <em>fallback</em>}
    </div>
  );
}

export default function App() {
  const globeRef = useRef(null);
  const [data, setData] = useState([]);
  const [trends, setTrends] = useState([]);
  const [videos, setVideos] = useState([]);
  const [health, setHealth] = useState(null);
  const [stats, setStats] = useState({});
  const [insight, setInsight] = useState({ summary_news: 'Building live intelligence brief.', summary_jobs: 'Scanning current hiring signals.' });
  const [selectedPoint, setSelectedPoint] = useState(null);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState('all');
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [portalOpen, setPortalOpen] = useState(false);
  const [portalJobs, setPortalJobs] = useState([]);
  const [portalQuery, setPortalQuery] = useState('');
  const [portalPage, setPortalPage] = useState(1);
  const [portalTotal, setPortalTotal] = useState(0);
  const [portalStatus, setPortalStatus] = useState('all');
  const [portalTab, setPortalTab] = useState('inbox');
  const [portalAnalytics, setPortalAnalytics] = useState(null);
  const [resumeText, setResumeText] = useState('');
  const [resumeReport, setResumeReport] = useState('');
  const [agentQuestion, setAgentQuestion] = useState('How should I position my resume for the best current roles?');
  const [agentAnswer, setAgentAnswer] = useState('');
  const [rankedJobs, setRankedJobs] = useState([]);
  const [selectedPortalJob, setSelectedPortalJob] = useState(null);
  const [toolkitOutput, setToolkitOutput] = useState('');
  const [marketQuestion, setMarketQuestion] = useState('');
  const [marketAnswer, setMarketAnswer] = useState('');
  const [portalBusy, setPortalBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [aiMode, setAiMode] = useState('auto');
  const [aiModes, setAiModes] = useState([]);
  const [sourceRegistry, setSourceRegistry] = useState(null);
  const [freeModels, setFreeModels] = useState(null);
  const [integrations, setIntegrations] = useState(null);
  const [sourceHealth, setSourceHealth] = useState(null);
  const [resumeFileName, setResumeFileName] = useState('');
  const [aiAttribution, setAiAttribution] = useState({});
  const [globeMode, setGlobeMode] = useState('opportunity');

  const fetchOperationalConfig = useCallback(async () => {
    const [modesRes, sourcesRes, modelsRes, integrationsRes, healthRes] = await Promise.allSettled([
      apiFetch('/api/ai-modes'),
      apiFetch('/api/source-registry'),
      apiFetch('/api/free-models'),
      apiFetch('/api/integrations'),
      apiFetch('/api/source-health'),
    ]);
    if (modesRes.status === 'fulfilled' && modesRes.value.ok) {
      const json = await modesRes.value.json();
      setAiMode(json.active || 'auto');
      setAiModes(json.modes || []);
    }
    if (sourcesRes.status === 'fulfilled' && sourcesRes.value.ok) {
      setSourceRegistry(await sourcesRes.value.json());
    }
    if (modelsRes.status === 'fulfilled' && modelsRes.value.ok) setFreeModels(await modelsRes.value.json());
    if (integrationsRes.status === 'fulfilled' && integrationsRes.value.ok) setIntegrations(await integrationsRes.value.json());
    if (healthRes.status === 'fulfilled' && healthRes.value.ok) setSourceHealth(await healthRes.value.json());
  }, []);

  const fetchDashboard = useCallback(async () => {
    const dashPromise = apiFetch('/api/dashboard-data').then(async (res) => {
      if (!res.ok) return;
      const json = await res.json();
      setData(json.data || []);
      setVideos(normalizeVideos(json.videos || []));
      setTrends(json.trends || []);
      setStats(json.stats || {});
      setHealth(json.health || null);
    });
    const healthPromise = apiFetch('/api/health').then(async (res) => {
      const json = await res.json().catch(() => null);
      if (json) setHealth(json);
    });

    await Promise.allSettled([dashPromise, healthPromise]);

    Promise.allSettled([
      apiFetch('/api/latest-trends').then(async (res) => {
        if (!res.ok) return;
        const json = await res.json();
        setTrends(json.trends || []);
      }),
      apiFetch('/api/ai-insights').then(async (res) => {
        if (!res.ok) return;
        const json = await res.json();
        setInsight(json);
        setAiAttribution((current) => ({
          ...current,
          insight: { provider: json.provider, model: json.model, fallback: json.fallback },
        }));
        setVideos(normalizeVideos(json.videos || []));
      }),
      apiFetch('/api/videos').then(async (res) => {
        if (!res.ok) return;
        const json = await res.json();
        if (json.videos?.length) setVideos(normalizeVideos(json.videos));
      }),
    ]);
  }, []);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        fetchOperationalConfig();
        await fetchDashboard();
      } finally {
        if (mounted) setIsLoading(false);
      }
    };
    load();
    const timer = setInterval(load, 5 * 60 * 1000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [fetchDashboard, fetchOperationalConfig]);

  const forceRefresh = async () => {
    setIsRefreshing(true);
    try {
      const res = await apiFetch('/api/refresh', { method: 'POST' });
      const json = await res.json().catch(() => null);
      if (json?.data) setData(json.data || []);
      if (json?.trends) setTrends(json.trends || []);
      if (json?.videos) setVideos(normalizeVideos(json.videos || []));
      if (json?.stats) setStats(json.stats || {});
      if (json?.health) setHealth(json.health || null);
      if (!json?.data) await fetchDashboard();
      if (json?.health?.isRefreshing || json?.status === 'refreshing' || json?.status === 'already_refreshing') {
        window.setTimeout(() => {
          fetchDashboard();
          if (portalOpen) {
            fetchPortalJobs(1, portalQuery, portalStatus);
            fetchPortalAnalytics();
            fetchOperationalConfig();
          }
        }, 15000);
      }
      if (portalOpen) {
        await Promise.all([fetchPortalJobs(1, portalQuery, portalStatus), fetchPortalAnalytics(), fetchOperationalConfig()]);
      }
    } finally {
      setIsRefreshing(false);
    }
  };

  const fetchPortalJobs = async (page = 1, search = portalQuery, status = portalStatus) => {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(PORTAL_LIMIT),
      search,
      status,
    });
    const res = await apiFetch(`/api/portal-jobs?${params.toString()}`);
    const json = await res.json();
    setPortalJobs(json.jobs || []);
    setPortalTotal(json.total || 0);
    setPortalPage(json.page || page);
  };

  const fetchPortalAnalytics = async () => {
    const res = await apiFetch('/api/portal-analytics');
    if (res.ok) setPortalAnalytics(await res.json());
  };

  const changeAiMode = async (modeId) => {
    setAiMode(modeId);
    const res = await apiFetch('/api/ai-modes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: modeId }),
    });
    if (res.ok) {
      const json = await res.json();
      setAiMode(json.active || modeId);
      setAiModes(json.modes || aiModes);
      setHealth((current) => current ? { ...current, ai: { ...(current.ai || {}), mode: json.active || modeId } } : current);
    }
  };

  const uploadResumeFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setPortalBusy(true);
    setBusyLabel('Parsing resume');
    setResumeFileName(file.name);
    try {
      const formData = new FormData();
      formData.append('resume', file);
      const res = await apiFetch('/api/portal-resume-upload', {
        method: 'POST',
        body: formData,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'upload_failed');
      setResumeText(json.text || '');
    } catch (e) {
      setToolkitOutput(`Resume upload failed: ${e.message}`);
    } finally {
      setPortalBusy(false);
      setBusyLabel('');
      event.target.value = '';
    }
  };

  const openPortal = async () => {
    setPortalOpen(true);
    await Promise.all([fetchPortalJobs(1, '', portalStatus), fetchPortalAnalytics(), fetchOperationalConfig()]);
  };

  const updatePortalJob = async (job, patch) => {
    const res = await apiFetch(`/api/portal-jobs/${job.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const json = await res.json();
      setPortalJobs((items) => items.map((item) => item.id === job.id ? json.job : item));
      setSelectedPortalJob((current) => current?.id === job.id ? json.job : current);
      fetchPortalAnalytics();
    }
  };

  const deletePortalJob = async (job) => {
    const res = await apiFetch(`/api/portal-jobs/${job.id}`, { method: 'DELETE' });
    if (res.ok) {
      setPortalJobs((items) => items.filter((item) => item.id !== job.id));
      setSelectedPortalJob(null);
      fetchPortalAnalytics();
    }
  };

  const rankResume = async () => {
    if (!resumeText.trim()) return;
    setPortalBusy(true);
    setBusyLabel('Ranking jobs with Agentic RAG');
    try {
      const res = await apiFetch('/api/portal-rank-resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resumeText, limit: 20 }),
      });
      const json = await res.json();
      setRankedJobs(json.matches || []);
      setResumeReport(json.reportMarkdown || '');
      setAiAttribution((current) => ({
        ...current,
        resume: { provider: json.provider || 'Agentic RAG', model: json.model || 'deterministic-retriever', fallback: json.fallback ?? true },
      }));
    } finally {
      setPortalBusy(false);
      setBusyLabel('');
    }
  };

  const runAgenticRag = async () => {
    if (!resumeText.trim() && !agentQuestion.trim()) return;
    setPortalBusy(true);
    setBusyLabel('Running Agentic RAG coach');
    setAgentAnswer('');
    try {
      const res = await apiFetch('/api/portal-agentic-rag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resumeText, question: agentQuestion }),
      });
      const json = await res.json();
      setAgentAnswer(json.answer || 'No answer generated.');
      setAiAttribution((current) => ({
        ...current,
        agent: { provider: json.provider, model: json.model, fallback: json.fallback },
      }));
      if (json.matches?.length) setRankedJobs(json.matches);
      if (json.report) {
        setResumeReport([
          json.report.summary,
          '',
          ...(json.report.actions || []).map((item) => `- ${item}`),
        ].join('\n'));
      }
    } finally {
      setPortalBusy(false);
      setBusyLabel('');
    }
  };

  const runToolkit = async (type) => {
    if (!selectedPortalJob) return;
    setPortalBusy(true);
    setBusyLabel('Generating AI toolkit output');
    setToolkitOutput('');
    try {
      const res = await apiFetch('/api/portal-ai-toolkit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: selectedPortalJob.id, type, resumeText }),
      });
      const json = await res.json();
      setToolkitOutput(json.result || 'No output generated.');
      setAiAttribution((current) => ({
        ...current,
        toolkit: { provider: json.provider, model: json.model, fallback: json.fallback },
      }));
    } finally {
      setPortalBusy(false);
      setBusyLabel('');
    }
  };

  const askMarket = async () => {
    if (!marketQuestion.trim()) return;
    setPortalBusy(true);
    setBusyLabel('Analyzing market with RAG');
    try {
      const res = await apiFetch('/api/portal-market-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: marketQuestion, resumeText }),
      });
      const json = await res.json();
      setMarketAnswer(json.answer || 'No answer generated.');
      setAiAttribution((current) => ({
        ...current,
        market: { provider: json.provider, model: json.model, fallback: json.fallback },
      }));
    } finally {
      setPortalBusy(false);
      setBusyLabel('');
    }
  };

  const jobs = useMemo(() => data.filter((item) => item.type === 'job'), [data]);
  const news = useMemo(() => data.filter((item) => item.type === 'news'), [data]);

  const matchesQuery = useCallback((item, lower) => {
    if (!lower) return true;
    return [item.title, item.headline, item.company, item.source, item.location]
      .filter(Boolean)
      .some((value) => value.toLowerCase().includes(lower));
  }, []);

  const scopedSignals = useMemo(() => {
    const lower = query.trim().toLowerCase();
    return data
      .filter((item) => mode === 'all' || item.type === mode)
      .filter((item) => matchesQuery(item, lower));
  }, [data, matchesQuery, mode, query]);

  const scopedJobs = useMemo(() => {
    const lower = query.trim().toLowerCase();
    return jobs.filter((item) => matchesQuery(item, lower));
  }, [jobs, matchesQuery, query]);

  const scopedNews = useMemo(() => {
    const lower = query.trim().toLowerCase();
    return news.filter((item) => matchesQuery(item, lower));
  }, [matchesQuery, news, query]);

  const filteredFeed = useMemo(() => scopedSignals.slice(0, FEED_LIMIT), [scopedSignals]);

  const globeJobs = useMemo(() => scopedJobs.filter((item) => item.geoConfidence !== 'global').slice(0, FEED_LIMIT), [scopedJobs]);
  const globeNews = useMemo(() => scopedNews.filter((item) => item.geoConfidence !== 'global').slice(0, FEED_LIMIT), [scopedNews]);
  const globeSignals = useMemo(() => {
    if (globeMode === 'jobs') return globeJobs;
    if (globeMode === 'news') return globeNews;
    return [...globeJobs, ...globeNews];
  }, [globeJobs, globeMode, globeNews]);
  const globeClusters = useMemo(() => {
    const map = new Map();
    globeSignals.forEach((item) => {
      const label = item.geoLabel || item.location || 'Global';
      const key = label.toLowerCase();
      const current = map.get(key) || { label, lat: 0, lng: 0, count: 0, jobs: 0, news: 0, sources: new Set(), fresh: 0 };
      current.lat += Number(item.lat || 0);
      current.lng += Number(item.lng || 0);
      current.count += 1;
      current.jobs += item.type === 'job' ? 1 : 0;
      current.news += item.type === 'news' ? 1 : 0;
      current.sources.add(item.company || item.source || 'source');
      if (item.collectedAt && Date.now() - item.collectedAt < 6 * 60 * 60 * 1000) current.fresh += 1;
      map.set(key, current);
    });
    return [...map.values()]
      .map((cluster) => ({
        ...cluster,
        lat: cluster.count ? cluster.lat / cluster.count : 0,
        lng: cluster.count ? cluster.lng / cluster.count : 0,
        sourceCount: cluster.sources.size,
        labelText: `${cluster.label}: ${cluster.jobs} jobs / ${cluster.news} news`,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  }, [globeSignals]);
  const opportunityArcs = useMemo(() => {
    const jobsSlice = globeJobs.slice(0, 16);
    const newsSlice = globeNews.slice(0, 16);
    return jobsSlice
      .map((job, index) => {
        const newsItem = newsSlice[index % Math.max(newsSlice.length, 1)];
        if (!newsItem) return null;
        return {
          startLat: newsItem.lat,
          startLng: newsItem.lng,
          endLat: job.lat,
          endLng: job.lng,
          label: `${newsItem.source || 'News'} -> ${job.company || 'Role'}`,
        };
      })
      .filter(Boolean);
  }, [globeJobs, globeNews]);
  const radarSummary = useMemo(() => {
    const topCluster = globeClusters[0];
    const topSource = [...globeSignals.reduce((map, item) => {
      const label = item.company || item.source || 'Source';
      map.set(label, (map.get(label) || 0) + 1);
      return map;
    }, new Map()).entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      hotspot: topCluster?.label || 'Global',
      hotspotCount: topCluster?.count || 0,
      source: topSource?.[0] || 'Live sources',
      sourceCount: topSource?.[1] || 0,
      routes: opportunityArcs.length,
    };
  }, [globeClusters, globeSignals, opportunityArcs.length]);
  const worldCommand = useMemo(() => {
    const countBy = (items, getter, limit = 6) => [...items.reduce((map, item) => {
      const label = getter(item) || 'Unknown';
      map.set(label, (map.get(label) || 0) + 1);
      return map;
    }, new Map()).entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([label, count]) => ({ label, count }));
    const remoteJobs = jobs.filter((job) => /remote|anywhere|global|worldwide/i.test(`${job.location || ''} ${job.title || ''}`));
    const aiJobs = jobs.filter((job) => /ai|machine learning|ml|rag|llm|data scientist|genai/i.test(`${job.title || ''} ${job.company || ''}`));
    const freshNews = news.filter((item) => item.collectedAt && Date.now() - item.collectedAt < 24 * 60 * 60 * 1000);
    const recentSignals = [...scopedSignals]
      .sort((a, b) => (b.collectedAt || 0) - (a.collectedAt || 0))
      .slice(0, 7);
    const roleFamilies = [
      { label: 'AI / ML', count: aiJobs.length, query: 'ai', tone: 'blue' },
      { label: 'Remote', count: remoteJobs.length, query: 'remote', tone: 'green' },
      { label: 'Cloud', count: jobs.filter((job) => /cloud|devops|aws|azure|gcp|platform/i.test(job.title || '')).length, query: 'cloud', tone: 'violet' },
      { label: 'Frontend', count: jobs.filter((job) => /react|frontend|ui|javascript|web/i.test(job.title || '')).length, query: 'react', tone: 'amber' },
    ];
    return {
      missions: [
        {
          id: 'hotspot',
          icon: Target,
          label: 'Hotspot',
          value: radarSummary.hotspot,
          detail: `${radarSummary.hotspotCount} live signals`,
          query: radarSummary.hotspot,
          mode: 'opportunity',
        },
        {
          id: 'remote',
          icon: Compass,
          label: 'Remote hunt',
          value: remoteJobs.length,
          detail: `${Math.round((remoteJobs.length / Math.max(jobs.length, 1)) * 100)}% of tracked jobs`,
          query: 'remote',
          mode: 'jobs',
        },
        {
          id: 'ai',
          icon: Zap,
          label: 'AI lane',
          value: aiJobs.length,
          detail: 'AI, ML, RAG, LLM roles',
          query: 'ai',
          mode: 'jobs',
        },
        {
          id: 'routes',
          icon: Route,
          label: 'News -> jobs',
          value: opportunityArcs.length,
          detail: `${freshNews.length} fresh news signals`,
          query: '',
          mode: 'opportunity',
        },
      ],
      roleFamilies,
      sourceMix: countBy(scopedSignals, (item) => item.company || item.source, 7),
      corridors: globeClusters.slice(0, 6),
      recentSignals,
      totals: {
        jobs: jobs.length,
        news: news.length,
        freshNews: freshNews.length,
        sources: countBy(scopedSignals, (item) => item.company || item.source, 1000).length,
      },
    };
  }, [globeClusters, jobs, news, opportunityArcs.length, radarSummary.hotspot, radarSummary.hotspotCount, scopedSignals]);
  const freshTone = health?.lastError ? 'danger' : health?.isRefreshing ? 'warn' : 'good';
  const aiLabel = health?.ai?.available === false
    ? 'cooldown'
    : (health?.ai?.model || stats.modelName || 'fallback');

  useEffect(() => {
    if (!globeRef.current) return;
    const controls = globeRef.current.controls();
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.4;
    globeRef.current.pointOfView({ lat: 18, lng: 10, altitude: 2.15 });
  }, [isLoading]);

  useEffect(() => {
    if (!portalOpen) return;
    if (portalTab === 'inbox' && portalStatus === 'all') {
      setPortalStatus('open');
      fetchPortalJobs(1, portalQuery, 'open');
    }
    if (portalTab === 'applications' && !['applied', 'interview', 'offer', 'rejected'].includes(portalStatus)) {
      setPortalStatus('applied');
      fetchPortalJobs(1, portalQuery, 'applied');
    }
    if (portalTab === 'analytics') fetchPortalAnalytics();
  }, [portalTab, portalOpen]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <Globe2 size={26} />
          <div>
            <h1>World Intelligence Desk</h1>
            <p>Verified opportunity and technology signals</p>
          </div>
        </div>
        <nav className="desk-nav" aria-label="Workspace">
          <button onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}><Globe2 size={15} /> World</button>
          <button onClick={async () => { await openPortal(); setPortalTab('models'); }}><Cpu size={15} /> Free models</button>
          <button onClick={openPortal}><Briefcase size={15} /> Career desk</button>
        </nav>
        <div className="topbar-actions">
          <span className={`status-pill ${freshTone}`}>
            <Activity size={15} />
            {health?.isRefreshing ? 'Refreshing' : health?.lastError ? 'Degraded' : 'Live'}
          </span>
          <span className="data-age">updated {formatAge(health?.ageSeconds)}</span>
          <button className="icon-button" onClick={forceRefresh} disabled={isRefreshing} title="Refresh data">
            <RefreshCcw size={18} className={isRefreshing ? 'spin' : ''} />
          </button>
        </div>
      </header>

      {isRefreshing && (
        <div className="refresh-overlay">
          <RefreshCcw className="spin" size={18} />
          <span>Fetching latest jobs, news, videos, and market signals</span>
          <i />
        </div>
      )}

      <main>
        <section className="hero">
          <div className="globe-stage">
            {isLoading ? (
              <div className="loader"><RefreshCcw className="spin" size={28} /> Connecting live feeds</div>
            ) : (
              <Globe
                ref={globeRef}
                globeImageUrl="//unpkg.com/three-globe/example/img/earth-blue-marble.jpg"
                backgroundImageUrl="//unpkg.com/three-globe/example/img/night-sky.png"
                pointsData={globeMode === 'news' ? [] : globeJobs}
                pointLat="lat"
                pointLng="lng"
                pointColor={() => '#15b86a'}
                pointRadius={(d) => d.size || 0.36}
                pointAltitude={0.01}
                pointLabel={(d) => `${d.title || 'Role'}<br/>${d.company || 'Company'} - ${d.location || 'Remote'}`}
                ringsData={globeMode === 'jobs' ? [] : globeNews}
                ringLat="lat"
                ringLng="lng"
                ringColor={() => '#ef4444'}
                ringMaxRadius={(d) => d.radius || 3.6}
                ringPropagationSpeed={0.55}
                ringRepeatPeriod={900}
                arcsData={globeMode === 'opportunity' ? opportunityArcs : []}
                arcStartLat="startLat"
                arcStartLng="startLng"
                arcEndLat="endLat"
                arcEndLng="endLng"
                arcColor={() => ['rgba(239,68,68,0.18)', 'rgba(21,184,106,0.92)']}
                arcAltitude={0.18}
                arcStroke={0.45}
                arcDashLength={0.36}
                arcDashGap={1.1}
                arcDashAnimateTime={2600}
                labelsData={globeClusters}
                labelLat="lat"
                labelLng="lng"
                labelText="label"
                labelColor={() => '#ffffff'}
                labelSize={(d) => Math.min(1.45, 0.72 + d.count * 0.05)}
                labelDotRadius={(d) => Math.min(0.7, 0.18 + d.count * 0.025)}
                labelAltitude={0.025}
                onPointClick={setSelectedPoint}
              />
            )}
            {!isLoading && (
              <div className="globe-intel">
                <div className="globe-mode">
                  {[
                    ['opportunity', 'Radar'],
                    ['jobs', 'Jobs'],
                    ['news', 'News'],
                  ].map(([id, label]) => (
                    <button key={id} className={globeMode === id ? 'active' : ''} onClick={() => setGlobeMode(id)}>
                      {label}
                    </button>
                  ))}
                </div>
                <div className="radar-card">
                  <span>Opportunity Radar</span>
                  <strong>{radarSummary.hotspot}</strong>
                  <small>{radarSummary.hotspotCount} signals - {radarSummary.routes} live routes</small>
                </div>
                <div className="radar-stack">
                  {globeClusters.slice(0, 4).map((cluster) => (
                    <button key={cluster.label} onClick={() => setQuery(cluster.label)}>
                      <span>{cluster.label}</span>
                      <strong>{cluster.jobs}J / {cluster.news}N</strong>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <aside className="command-panel">
            <div className="panel-section">
              <span className="section-kicker"><ShieldCheck size={15} /> System</span>
              <div className="metrics-grid">
                <Metric icon={Briefcase} label="Jobs" value={stats.totalJobs ?? jobs.length} tone="green" />
                <Metric icon={Newspaper} label="News" value={stats.totalNews ?? news.length} tone="red" />
                <Metric icon={Database} label="Sources" value={(stats.jobSources || 0) + (stats.newsSources || 0)} />
                <Metric icon={Bot} label="Model" value={aiLabel} />
              </div>
            </div>

            <div className="panel-section">
              <span className="section-kicker"><Sparkles size={15} /> AI Brief</span>
              <p className="brief-text">{insight.summary_news}</p>
              <p className="brief-text muted">{insight.summary_jobs}</p>
              <div className="model-line">
                <Bot size={14} />
                <span>{health?.ai?.available === false ? 'AI cooldown active' : (health?.ai?.provider || stats.modelProvider || 'Fallback router')} / {aiLabel}</span>
              </div>
              <AiBadge meta={aiAttribution.insight || health?.ai} label="Brief" />
            </div>

            <div className="panel-section">
              <span className="section-kicker"><Filter size={15} /> Controls</span>
              <div className="search-box">
                <Search size={16} />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search company, source, role" />
              </div>
              <div className="segmented">
                {['all', 'job', 'news'].map((item) => (
                  <button key={item} className={mode === item ? 'active' : ''} onClick={() => setMode(item)}>
                    {item}
                  </button>
                ))}
              </div>
              <div className="freshness">
                <span>Updated {formatAge(health?.ageSeconds)}</span>
                <span>{health?.dbConnected ? 'database on' : 'memory cache'}</span>
              </div>
            </div>
          </aside>
        </section>

        <section className="world-command">
          <div className="world-command-head">
            <div>
              <span className="section-kicker"><Globe2 size={15} /> World Command</span>
              <h2>Global Opportunity Intelligence</h2>
            </div>
            <div className="world-scoreboard">
              <span>{worldCommand.totals.jobs} jobs</span>
              <span>{worldCommand.totals.news} news</span>
              <span>{worldCommand.totals.sources} sources</span>
              <span>{worldCommand.totals.freshNews} fresh</span>
            </div>
          </div>

          <div className="mission-grid">
            {worldCommand.missions.map((mission) => {
              const Icon = mission.icon;
              return (
                <button
                  className="mission-card"
                  key={mission.id}
                  onClick={() => {
                    setGlobeMode(mission.mode);
                    setMode(mission.mode === 'news' ? 'news' : mission.mode === 'jobs' ? 'job' : 'all');
                    setQuery(mission.query || '');
                  }}
                >
                  <Icon size={18} />
                  <span>{mission.label}</span>
                  <strong>{mission.value}</strong>
                  <small>{mission.detail}</small>
                </button>
              );
            })}
          </div>

          <div className="world-intel-grid">
            <div className="world-panel corridor-panel">
              <div className="world-panel-head">
                <h3><Route size={17} /> Market Corridors</h3>
                <span>{opportunityArcs.length} routes</span>
              </div>
              <div className="corridor-list">
                {worldCommand.corridors.map((cluster) => {
                  const max = Math.max(...worldCommand.corridors.map((item) => item.count || 0), 1);
                  return (
                    <button key={cluster.label} onClick={() => { setQuery(cluster.label); setGlobeMode('opportunity'); }}>
                      <span>
                        <strong>{cluster.label}</strong>
                        <em>{cluster.sourceCount} sources - {cluster.fresh} fresh</em>
                        <i style={{ width: `${Math.max(10, Math.round((cluster.count / max) * 100))}%` }} />
                      </span>
                      <b>{cluster.jobs}J / {cluster.news}N</b>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="world-panel role-panel">
              <div className="world-panel-head">
                <h3><Target size={17} /> Opportunity Lanes</h3>
                <span>{worldCommand.roleFamilies.reduce((sum, row) => sum + row.count, 0)} matches</span>
              </div>
              <div className="lane-grid">
                {worldCommand.roleFamilies.map((lane) => (
                  <button className={`lane-card ${lane.tone}`} key={lane.label} onClick={() => { setMode('job'); setGlobeMode('jobs'); setQuery(lane.query); }}>
                    <span>{lane.label}</span>
                    <strong>{lane.count}</strong>
                  </button>
                ))}
              </div>
              <div className="source-mix">
                {worldCommand.sourceMix.slice(0, 5).map((source) => (
                  <button key={source.label} onClick={() => setQuery(source.label)}>
                    <span>{source.label}</span>
                    <strong>{source.count}</strong>
                  </button>
                ))}
              </div>
            </div>

            <div className="world-panel timeline-panel">
              <div className="world-panel-head">
                <h3><Clock3 size={17} /> Live Storyline</h3>
                <span>{formatAge(health?.ageSeconds)}</span>
              </div>
              <div className="signal-timeline">
                {worldCommand.recentSignals.map((signal) => (
                  <button key={signal.id || signal.url} onClick={() => setSelectedPoint(signal)}>
                    <i className={signal.type} />
                    <span>
                      <strong>{signal.title || signal.headline}</strong>
                      <em>{signal.company || signal.source || 'Source'} - {signal.location || 'Global'}</em>
                    </span>
                    <small>{signal.collectedAt ? formatDateAge(signal.collectedAt) : signal.time || 'live'}</small>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="content-grid">
          <div className="workspace wide">
            <div className="workspace-header">
              <h2><Layers size={19} /> Fresh Evidence</h2>
              <span>{filteredFeed.length} visible</span>
            </div>
            <div className="feed-list">
              {(isLoading || isRefreshing) && filteredFeed.length === 0 && <SkeletonRows count={8} />}
              {filteredFeed.length === 0 && !isLoading && !isRefreshing && <EmptyState title="No matching signals yet." />}
              {filteredFeed.map((item) => (
                <button key={item.id || item.url} className={`feed-row ${item.type}`} onClick={() => setSelectedPoint(item)}>
                  <span className="feed-type">{item.type === 'job' ? <Briefcase size={15} /> : <Newspaper size={15} />}</span>
                  <span className="feed-main">
                    <strong>{item.title || item.headline}</strong>
                    <small>{item.company || item.source || 'Source'} - {item.location || 'Global'}</small>
                  </span>
                  <span className={`feed-time ${item.freshness || 'verified'}`}>
                    <i /> {item.publishedAt || item.collectedAt ? formatDateAge(item.publishedAt || item.collectedAt) : 'verified now'}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="workspace">
            <div className="workspace-header">
              <h2><TrendingUp size={19} /> Trends</h2>
              <span>{trends.length}</span>
            </div>
            <div className="stack-list">
              {(isLoading || isRefreshing) && trends.length === 0 && <SkeletonRows count={5} />}
              {trends.slice(0, 12).map((trend) => (
                <a className="trend-row" href={trend.url} target="_blank" rel="noreferrer" key={trend.id || trend.url}>
                  <strong>{trend.title}</strong>
                  <small>{trend.source} - {trend.category || 'tech'}</small>
                </a>
              ))}
              {trends.length === 0 && !isLoading && !isRefreshing && <EmptyState title="Trends are warming up." />}
            </div>
          </div>

          <div className="workspace">
            <div className="workspace-header">
              <h2><Video size={19} /> Video Watchlist</h2>
              <span>{videos.length}</span>
            </div>
            <div className="video-list">
              {(isLoading || isRefreshing) && videos.length === 0 && <SkeletonRows count={4} media />}
              {videos.slice(0, 8).map((video) => (
                <a className="video-row" href={`https://www.youtube.com/watch?v=${video.videoId}`} target="_blank" rel="noreferrer" key={video.videoId}>
                  <img src={`https://img.youtube.com/vi/${video.videoId}/mqdefault.jpg`} alt="" loading="lazy" />
                  <span>
                    <strong>{video.title}</strong>
                    <small><Play size={12} /> {video.channel || 'YouTube'} - {formatDateAge(video.publishedAt || video.published_at)}</small>
                  </span>
                </a>
              ))}
              {videos.length === 0 && !isLoading && !isRefreshing && <EmptyState title="Video queue is empty." />}
            </div>
          </div>
        </section>

        <section className="portal-strip">
          <div>
            <h2><Building2 size={20} /> Smart Job Portal</h2>
            <p>{portalTotal || stats.totalJobs || jobs.length} tracked roles from {sourceRegistry?.counts?.totalJobs || stats.jobSources || 'live'} job sources</p>
          </div>
          <button className="primary-button" onClick={openPortal}>
            Open portal <ArrowUpRight size={16} />
          </button>
        </section>
      </main>

      {selectedPoint && (
        <div className="modal-backdrop" onClick={() => setSelectedPoint(null)}>
          <div className="detail-modal" onClick={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setSelectedPoint(null)} title="Close"><X size={18} /></button>
            <span className={`detail-label ${selectedPoint.type}`}>{selectedPoint.type}</span>
            <h3>{selectedPoint.title || selectedPoint.headline}</h3>
            <p>{selectedPoint.company || selectedPoint.source || 'Global source'}</p>
            <div className="detail-grid">
              <span><MapPin size={14} /> {selectedPoint.location || 'Global'}</span>
              <span>{selectedPoint.time || 'live'}</span>
            </div>
            {selectedPoint.url && selectedPoint.url !== '#' && (
              <a className="primary-button full" href={selectedPoint.url} target="_blank" rel="noreferrer">
                {selectedPoint.type === 'job' ? 'Apply on source' : 'Read full story'} <ExternalLink size={15} />
              </a>
            )}
          </div>
        </div>
      )}

      {portalOpen && (
        <div className="modal-backdrop" onClick={() => setPortalOpen(false)}>
          <div className="portal-modal" onClick={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setPortalOpen(false)} title="Close"><X size={18} /></button>
            {portalBusy && (
              <div className="portal-busy">
                <div className="agent-orbit"><Bot size={22} /></div>
                <strong>{busyLabel || 'Working'}</strong>
                <span>Retrieving evidence, ranking matches, and preparing grounded output</span>
              </div>
            )}
            <div className="workspace-header">
              <div>
                <h2><Briefcase size={20} /> Smart Job Portal Pro</h2>
                <p>{sourceRegistry?.counts?.boards || 0} board probes, {sourceRegistry?.counts?.apis || 0} APIs, {sourceRegistry?.counts?.rss || 0} feeds</p>
              </div>
              <span>{portalTotal || portalAnalytics?.totals?.jobs || 0} roles</span>
            </div>
            <div className="portal-command">
              <Metric icon={Briefcase} label="Tracked" value={portalAnalytics?.totals?.jobs || portalTotal || 0} />
              <Metric icon={Activity} label="Applied" value={portalAnalytics?.totals?.applied || 0} />
              <Metric icon={ShieldCheck} label="Interviews" value={portalAnalytics?.totals?.interviews || 0} />
              <label className="ai-mode-control">
                <span>AI mode</span>
                <select value={aiMode} onChange={(event) => changeAiMode(event.target.value)}>
                  {(aiModes.length ? aiModes : [{ id: 'auto', label: 'Auto fallback' }, { id: 'offline', label: 'Offline deterministic' }]).map((modeOption) => (
                    <option key={modeOption.id} value={modeOption.id}>
                      {modeOption.label}{modeOption.available === false ? ' (not configured)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <button className="primary-button" onClick={forceRefresh} disabled={isRefreshing}>
                <RefreshCcw size={16} /> {isRefreshing ? 'Refreshing' : 'Refresh'}
              </button>
            </div>
            <div className="portal-tabs">
              {[
                ['inbox', 'Inbox'],
                ['applications', 'Applications'],
                ['analytics', 'Analytics'],
                ['coach', 'Resume AI'],
                ['market', 'Market Q&A'],
                ['models', 'Free Models'],
              ].map(([id, label]) => (
                <button key={id} className={portalTab === id ? 'active' : ''} onClick={() => setPortalTab(id)}>{label}</button>
              ))}
              <a href={apiUrl('/api/portal-export.csv')} className="export-link">Export CSV</a>
            </div>
            {(portalTab === 'inbox' || portalTab === 'applications') && <div className="portal-search">
              <div className="search-box">
                <Search size={16} />
                <input
                  value={portalQuery}
                  onChange={(event) => setPortalQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') fetchPortalJobs(1, portalQuery, portalStatus);
                  }}
                  placeholder="Search title, company, or source"
                />
              </div>
              <select className="portal-select" value={portalStatus} onChange={(event) => { setPortalStatus(event.target.value); fetchPortalJobs(1, portalQuery, event.target.value); }}>
                {['all', 'open', 'applied', 'interview', 'offer', 'rejected', 'archived'].map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
              <button className="icon-button" onClick={() => fetchPortalJobs(1, portalQuery, portalStatus)} title="Search">
                <Search size={17} />
              </button>
            </div>}

            {(portalTab === 'inbox' || portalTab === 'applications') && (
              <div className="portal-workbench">
                <div className="portal-list">
                  {portalJobs
                    .filter((job) => portalTab === 'inbox' ? !['applied', 'interview', 'offer'].includes(job.status) : ['applied', 'interview', 'offer', 'rejected'].includes(job.status))
                    .map((job) => (
                      <div className="portal-job-shell" key={job.id || job.url}>
                        <button className={`portal-job ${selectedPortalJob?.id === job.id ? 'active' : ''}`} onClick={() => setSelectedPortalJob(job)}>
                          <strong>{job.title}</strong>
                          <span>{job.company} - {job.location || 'Remote'}</span>
                          <small>{job.status || 'open'} {job.match_score ? `- ${job.match_score}% match` : ''} - refreshed {formatDateAge(job.refreshed_at)}</small>
                        </button>
                        {job.url && <a className="quick-apply" href={job.url} target="_blank" rel="noreferrer" title="Apply on source"><ExternalLink size={14} /> Apply</a>}
                      </div>
                    ))}
                  {portalJobs.length === 0 && <EmptyState title="No jobs found for this filter." />}
                </div>
                <div className="job-detail-panel">
                  {!selectedPortalJob && <EmptyState title="Select a job to manage status, notes, and AI toolkit actions." />}
                  {selectedPortalJob && (
                    <>
                      <h3>{selectedPortalJob.title}</h3>
                      <p>{selectedPortalJob.company} - {selectedPortalJob.location || 'Remote'} - {selectedPortalJob.source || 'Source'}</p>
                      <div className="job-actions">
                        {['applied', 'interview', 'offer', 'rejected', 'archived'].map((status) => (
                          <button key={status} onClick={() => updatePortalJob(selectedPortalJob, { status })}>{status}</button>
                        ))}
                        <a href={selectedPortalJob.url || '#'} target="_blank" rel="noreferrer">Apply on source <ExternalLink size={13} /></a>
                      </div>
                      <textarea
                        className="notes-box"
                        value={selectedPortalJob.notes || ''}
                        onChange={(event) => setSelectedPortalJob({ ...selectedPortalJob, notes: event.target.value })}
                        placeholder="Notes, recruiter names, follow-up plan..."
                      />
                      <div className="job-actions">
                        <button onClick={() => updatePortalJob(selectedPortalJob, { notes: selectedPortalJob.notes || '' })}>Save notes</button>
                        <button onClick={() => deletePortalJob(selectedPortalJob)}>Delete</button>
                      </div>
                      <div className="toolkit-buttons">
                        <button onClick={() => runToolkit('cover-letter')}>Cover letter</button>
                        <button onClick={() => runToolkit('interview-prep')}>Interview prep</button>
                        <button onClick={() => runToolkit('cold-message')}>Cold message</button>
                        <button onClick={() => runToolkit('skill-gap')}>Skill gaps</button>
                        <button onClick={() => runToolkit('resume-summary')}>Resume fit</button>
                        <button onClick={() => runToolkit('recruiter-email')}>Recruiter email</button>
                      </div>
                      {portalBusy && <p className="muted-line">Working...</p>}
                      {toolkitOutput && (
                        <>
                          <AiBadge meta={aiAttribution.toolkit} label="Toolkit" />
                          <pre className="ai-output">{toolkitOutput}</pre>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}

            {portalTab === 'analytics' && (
              <div className="portal-analytics">
                <div className="analytics-cards">
                  <Metric icon={Briefcase} label="Tracked" value={portalAnalytics?.totals?.jobs || 0} />
                  <Metric icon={Activity} label="Applied" value={portalAnalytics?.totals?.applied || 0} />
                  <Metric icon={ShieldCheck} label="Interviews" value={portalAnalytics?.totals?.interviews || 0} />
                  <Metric icon={Sparkles} label="Offers" value={portalAnalytics?.totals?.offers || 0} />
                  <Metric icon={Building2} label="Companies" value={portalAnalytics?.totals?.companies || 0} />
                  <Metric icon={Database} label="Sources" value={portalAnalytics?.totals?.sources || 0} />
                  <Metric icon={Globe2} label="Remote" value={portalAnalytics?.totals?.remote || 0} />
                  <Metric icon={TrendingUp} label="Apply rate" value={`${portalAnalytics?.conversion?.applyRate || 0}%`} />
                </div>
                <div className="analytics-grid">
                  {[
                    ['Funnel', portalAnalytics?.funnel],
                    ['Role clusters', portalAnalytics?.roleFamilies],
                    ['Top companies', portalAnalytics?.topCompanies],
                    ['Top sources', portalAnalytics?.topSources],
                    ['Freshness', portalAnalytics?.freshness],
                    ['Top skills', portalAnalytics?.keywords],
                    ['Work mode', portalAnalytics?.workModes],
                    ['Seniority', portalAnalytics?.seniority],
                    ['Top titles', portalAnalytics?.topTitles],
                    ['Source / mode', portalAnalytics?.sourceWorkMode],
                  ].map(([title, rows]) => (
                    <div className="analytics-panel" key={title}>
                      <h3>{title}</h3>
                      {(rows || []).map((row) => {
                        const max = Math.max(...(rows || []).map((item) => item.count || 0), 1);
                        return (
                          <div className="bar-row" key={row.label}>
                            <span>
                              {row.label}
                              <i style={{ width: `${Math.max(8, Math.round(((row.count || 0) / max) * 100))}%` }} />
                            </span>
                            <strong>{row.count}</strong>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {portalTab === 'models' && (
              <div className="model-control-room">
                <div className="model-room-header">
                  <div>
                    <span className="section-kicker"><Cpu size={15} /> Open Model Runtime</span>
                    <h3>Private local inference with hosted free fallbacks</h3>
                    <p>Choose <strong>Free models only</strong> to keep paid providers out of the route.</p>
                  </div>
                  <label className="ai-mode-control model-mode-select">
                    <span>Active route</span>
                    <select value={aiMode} onChange={(event) => changeAiMode(event.target.value)}>
                      {aiModes.map((modeOption) => <option key={modeOption.id} value={modeOption.id}>{modeOption.label}</option>)}
                    </select>
                  </label>
                </div>

                <div className="provider-grid">
                  {(freeModels?.providers || []).map((provider) => (
                    <section className={`provider-panel ${provider.reachable ? 'online' : 'offline'}`} key={provider.id}>
                      <header>
                        {provider.kind === 'local' ? <Server size={19} /> : <Cloud size={19} />}
                        <div><strong>{provider.name}</strong><span>{provider.kind} inference</span></div>
                        <em>{provider.reachable ? 'ready' : 'setup needed'}</em>
                      </header>
                      <p>{provider.note}</p>
                      <div className="model-list">
                        {(provider.models || []).slice(0, 8).map((model) => (
                          <span key={model.id}><i className={model.installed ? 'ready' : ''} />{cleanModelLabel(model.id)}{model.deployment === 'cloud' ? ' · cloud' : model.source === 'Hugging Face Hub' ? ' · HF Hub' : ''}</span>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>

                <div className="runtime-grid">
                  <section className="runtime-panel">
                    <h3>Fallback route</h3>
                    <div className="route-line">
                      {(freeModels?.routing || []).map((step, index) => (
                        <React.Fragment key={step}><span>{index + 1}. {step}</span>{index < (freeModels?.routing || []).length - 1 && <ArrowUpRight size={14} />}</React.Fragment>
                      ))}
                    </div>
                    <AiBadge meta={freeModels?.lastRuntime} label="Last response" />
                  </section>
                  <section className="runtime-panel">
                    <h3>Data integrations</h3>
                    <div className="integration-row"><span>DailyNewsUpdate</span><strong>{integrations?.dailyNewsUpdate?.connected ? 'read-only connected' : 'not found'}</strong></div>
                    <div className="integration-row"><span>LinkedIn</span><strong>{integrations?.linkedin?.connected ? `${integrations.linkedin.items} approved posts` : 'authorization/import needed'}</strong></div>
                    <div className="integration-row"><span>YouTube API</span><strong>{integrations?.youtube?.apiConfigured ? 'configured' : 'search fallback'}</strong></div>
                    <div className="integration-row"><span>Source checks</span><strong>{sourceHealth ? `${sourceHealth.healthy} healthy / ${sourceHealth.failing} failing` : 'warming up'}</strong></div>
                  </section>
                </div>

                {sourceHealth?.failing > 0 && (
                  <section className="source-failures">
                    <h3>Sources needing attention</h3>
                    {sourceHealth.sources.filter((source) => !source.ok).slice(0, 10).map((source) => (
                      <div key={`${source.kind}-${source.source}`}><span>{source.source}</span><small>{source.kind} - {source.detail || 'request failed'}</small></div>
                    ))}
                  </section>
                )}
              </div>
            )}

            {portalTab === 'coach' && (
              <div className="coach-grid">
                <div>
                  <h3>Resume Center</h3>
                  <label className="upload-drop">
                    <Upload size={18} />
                    <span>{resumeFileName || 'Upload PDF, DOCX, TXT, or MD resume'}</span>
                    <input type="file" accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown" onChange={uploadResumeFile} />
                  </label>
                  <textarea className="resume-box" value={resumeText} onChange={(event) => setResumeText(event.target.value)} placeholder="Paste your resume text here for matching and targeted generation." />
                  <button className="primary-button full" onClick={rankResume} disabled={portalBusy || !resumeText.trim()}>Rank my jobs</button>
                  <div className="agent-box">
                    <h3>Agentic RAG Coach</h3>
                    <input value={agentQuestion} onChange={(event) => setAgentQuestion(event.target.value)} placeholder="Ask: What roles should I target? What skills are missing?" />
                    <button className="primary-button full" onClick={runAgenticRag} disabled={portalBusy}>Run RAG coach</button>
                  </div>
                  {resumeReport && (
                    <>
                      <AiBadge meta={aiAttribution.resume} label="Resume ranker" />
                      <pre className="ai-output">{resumeReport}</pre>
                    </>
                  )}
                </div>
                <div className="portal-list">
                  {agentAnswer && (
                    <>
                      <AiBadge meta={aiAttribution.agent} label="RAG coach" />
                      <pre className="ai-output">{agentAnswer}</pre>
                    </>
                  )}
                  {rankedJobs.map((job) => (
                    <div className="ranked-job-row" key={job.id}>
                      <button className="portal-job" onClick={() => { setSelectedPortalJob(job); setPortalTab('applications'); }}>
                        <strong>{job.match_score}% - {job.title}</strong>
                        <span>{job.company} - {job.location || 'Remote'}</span>
                        <small>{job.match_explanation?.confidence || 'exploratory'} confidence - {(job.match_explanation?.reasons || []).join(' - ')}</small>
                      </button>
                      {(job.application_url || job.url) && <a className="quick-apply" href={job.application_url || job.url} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Apply</a>}
                    </div>
                  ))}
                  {rankedJobs.length === 0 && <EmptyState title="Paste your resume and rank jobs to see best matches." />}
                </div>
              </div>
            )}

            {portalTab === 'market' && (
              <div className="market-panel">
                <h3>Ask your job database</h3>
                <div className="portal-search">
                  <div className="search-box">
                    <Search size={16} />
                    <input value={marketQuestion} onChange={(event) => setMarketQuestion(event.target.value)} placeholder="Which companies are hiring remote React engineers?" />
                  </div>
                  <button className="primary-button" onClick={askMarket} disabled={portalBusy}>Analyze</button>
                </div>
                {marketAnswer ? (
                  <>
                    <AiBadge meta={aiAttribution.market} label="Market Q&A" />
                    <pre className="ai-output">{marketAnswer}</pre>
                  </>
                ) : <EmptyState title="Ask about companies, skills, locations, salary signals, or hiring trends." />}
              </div>
            )}

            {(portalTab === 'inbox' || portalTab === 'applications') && <div className="portal-pager">
              <button disabled={portalPage <= 1} onClick={() => fetchPortalJobs(portalPage - 1, portalQuery, portalStatus)}>Previous</button>
              <span>Page {portalPage}</span>
              <button disabled={portalJobs.length < PORTAL_LIMIT} onClick={() => fetchPortalJobs(portalPage + 1, portalQuery, portalStatus)}>Next</button>
            </div>}
          </div>
        </div>
      )}
    </div>
  );
}
