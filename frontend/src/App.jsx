import React, { useState, useEffect, useRef, useMemo } from 'react';
import Globe from 'react-globe.gl';
import { motion, AnimatePresence } from 'framer-motion';
import { Activity, Briefcase, Globe2, Radio, Target, Zap, Bot, MapPin, Building2, Video, X, ExternalLink, TrendingUp, Newspaper, Filter, Database, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Layers, Search, ArrowUpRight } from 'lucide-react';

const FEED_PER_PAGE = 24;
const TREND_PER_PAGE = 18;
const VIDEO_PER_PAGE = 12;
const PORTAL_PER_PAGE = 20;

const TypewriterText = ({ text }) => {
  const [displayed, setDisplayed] = useState('');
  useEffect(() => {
    let i = 0; setDisplayed('');
    const iv = setInterval(() => { setDisplayed(p => p + (text.charAt(i) || '')); i++; if (i >= text.length) clearInterval(iv); }, 12);
    return () => clearInterval(iv);
  }, [text]);
  return <span>{displayed}</span>;
};

const Pagination = ({ page, totalPages, onPageChange, total, label }) => (
  <div className="pagination">
    <button className="pg-btn" disabled={page <= 1} onClick={() => onPageChange(page - 1)}><ChevronLeft size={16} /></button>
    <span className="pg-info">{label || `Page ${page}`} of {totalPages} ({total} items)</span>
    <button className="pg-btn" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}><ChevronRight size={16} /></button>
  </div>
);

const App = () => {
  const globeRef = useRef();
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ jobs: true, news: true, remote: false, engineering: false, enterprise: false });
  const [aiInsight, setAiInsight] = useState("Initializing Global Intelligence Engine...");
  const [videoQueries, setVideoQueries] = useState([]);
  const [selectedPoint, setSelectedPoint] = useState(null);
  const [companyNodes, setCompanyNodes] = useState([]);
  const [learningCompany, setLearningCompany] = useState(false);
  const [trends, setTrends] = useState([]);
  const [trendFilter, setTrendFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showSections, setShowSections] = useState({ feed: true, trends: true, videos: true });
  const [lastRefresh, setLastRefresh] = useState(null);
  const [stats, setStats] = useState({});
  const [overlayCollapsed, setOverlayCollapsed] = useState(false);
  // Pagination
  const [feedPage, setFeedPage] = useState(1);
  const [trendPage, setTrendPage] = useState(1);
  const [videoPage, setVideoPage] = useState(1);
  const [videoFilter, setVideoFilter] = useState('all');
  // Portal state
  const [showPortal, setShowPortal] = useState(false);
  const [portalJobs, setPortalJobs] = useState([]);
  const [portalTotal, setPortalTotal] = useState(0);
  const [portalPage, setPortalPage] = useState(1);
  const [portalTotalPages, setPortalTotalPages] = useState(1);
  const [portalSearch, setPortalSearch] = useState('');
  const [portalLoading, setPortalLoading] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [dashRes, aiRes, trendRes] = await Promise.all([
          fetch('http://localhost:8000/api/dashboard-data'),
          fetch('http://localhost:8000/api/ai-insights'),
          fetch('http://localhost:8000/api/latest-trends')
        ]);
        const dashJson = await dashRes.json();
        setData(dashJson.data || []);
        if (dashJson.stats) setStats(dashJson.stats);
        if (aiRes.ok) {
          const aiJson = await aiRes.json();
          setAiInsight(`📰 NEWS: ${aiJson.summary_news}\n\n💼 JOBS: ${aiJson.summary_jobs}`);
          if (aiJson.videos) setVideoQueries(aiJson.videos);
        }
        if (trendRes.ok) { const j = await trendRes.json(); setTrends(j.trends || []); }
        setLastRefresh(new Date());
      } catch (err) {
        setAiInsight("Backend disconnected. Ensure Node.js server is running on port 8000.");
      } finally { setLoading(false); }
    };
    fetchData();
    const iv = setInterval(fetchData, 10 * 60 * 1000);
    return () => clearInterval(iv);
  }, []);

  // Portal fetch
  const fetchPortalJobs = async (page = 1, search = '') => {
    setPortalLoading(true);
    try {
      const res = await fetch(`http://localhost:8000/api/portal-jobs?page=${page}&limit=${PORTAL_PER_PAGE}&search=${encodeURIComponent(search)}`);
      const json = await res.json();
      setPortalJobs(json.jobs || []);
      setPortalTotal(json.total || 0);
      setPortalPage(json.page || 1);
      setPortalTotalPages(json.totalPages || 1);
    } catch (e) { } finally { setPortalLoading(false); }
  };

  useEffect(() => { if (showPortal) fetchPortalJobs(portalPage, portalSearch); }, [showPortal, portalPage]);

  const filteredJobs = useMemo(() => data.filter(item => {
    if (item.type !== 'job' || !filters.jobs) return false;
    if (filters.remote && !item.isRemote) return false;
    if (filters.engineering) { const t = (item.title || '').toLowerCase(); if (!t.includes('engineer') && !t.includes('developer') && !t.includes('software')) return false; }
    if (searchQuery) { const q = searchQuery.toLowerCase(); if (!(item.title || '').toLowerCase().includes(q) && !(item.company || '').toLowerCase().includes(q)) return false; }
    return true;
  }), [data, filters, searchQuery]);

  const filteredNews = useMemo(() => data.filter(item => {
    if (item.type !== 'news' || !filters.news) return false;
    if (filters.enterprise) { const h = (item.headline || '').toLowerCase(); if (!h.includes('ai') && !h.includes('tech') && !h.includes('startup') && !h.includes('model') && !h.includes('openai') && !h.includes('google')) return false; }
    if (searchQuery) { if (!(item.headline || '').toLowerCase().includes(searchQuery.toLowerCase())) return false; }
    return true;
  }), [data, filters, searchQuery]);

  const allFiltered = useMemo(() => [...filteredJobs, ...filteredNews, ...companyNodes], [filteredJobs, filteredNews, companyNodes]);
  const filteredTrends = useMemo(() => trendFilter === 'all' ? trends : trends.filter(t => t.category === trendFilter), [trends, trendFilter]);
  const filteredVideos = useMemo(() => videoFilter === 'all' ? videoQueries : videoQueries.filter(v => v.category === videoFilter), [videoQueries, videoFilter]);

  // Paginated slices
  const feedSlice = useMemo(() => allFiltered.slice((feedPage - 1) * FEED_PER_PAGE, feedPage * FEED_PER_PAGE), [allFiltered, feedPage]);
  const trendSlice = useMemo(() => filteredTrends.slice((trendPage - 1) * TREND_PER_PAGE, trendPage * TREND_PER_PAGE), [filteredTrends, trendPage]);
  const videoSlice = useMemo(() => filteredVideos.slice((videoPage - 1) * VIDEO_PER_PAGE, videoPage * VIDEO_PER_PAGE), [filteredVideos, videoPage]);

  const handleFilterToggle = (key) => { setFilters(prev => ({ ...prev, [key]: !prev[key] })); setFeedPage(1); };

  const searchCompanyBranches = async () => {
    if (!searchQuery) return;
    setLearningCompany(true);
    try {
      const res = await fetch(`http://localhost:8000/api/company-intel?company=${encodeURIComponent(searchQuery)}`);
      const json = await res.json();
      if (json?.branches) {
        setCompanyNodes(json.branches.map((b, i) => ({
          id: `company-intel-${i}`, type: 'job', lat: b.lat, lng: b.lng,
          company: searchQuery, title: 'Corporate Branch', location: b.city,
          url: '#', isRemote: false, time: 'AI Intel', size: 0.6, color: '#45f3ff'
        })));
      }
    } catch (e) { } finally { setLearningCompany(false); }
  };

  const globeReady = () => {
    if (globeRef.current) {
      globeRef.current.controls().autoRotate = true;
      globeRef.current.controls().autoRotateSpeed = 0.5;
      globeRef.current.pointOfView({ lat: 20, lng: 0, altitude: 2 });
    }
  };

  const handlePointClick = (point) => {
    if (globeRef.current) globeRef.current.pointOfView({ lat: point.lat, lng: point.lng, altitude: 0.8 }, 1000);
    setSelectedPoint(point);
  };

  const openJobInPortal = (url) => {
    if (url && url !== '#') window.open(url, '_blank');
    else setShowPortal(true);
  };

  return (
    <div className="page-root">
      {/* ═══════ HERO: Globe ═══════ */}
      <section className="hero-section">
        <div className="globe-wrapper">
          {loading ? (
            <div className="globe-loader"><Globe2 size={48} className="spin" /> <span>Connecting to Global Satellite Network...</span></div>
          ) : (
            <Globe ref={globeRef} onGlobeReady={globeReady}
              globeImageUrl="//unpkg.com/three-globe/example/img/earth-night.jpg"
              backgroundImageUrl="//unpkg.com/three-globe/example/img/night-sky.png"
              pointsData={[...filteredJobs, ...companyNodes]}
              pointLat="lat" pointLng="lng" pointColor="color" pointRadius="size"
              pointAltitude={0.01} onPointClick={handlePointClick}
              ringsData={filteredNews}
              ringLat="lat" ringLng="lng" ringColor="color" ringMaxRadius="radius"
              ringPropagationSpeed={0.5} ringRepeatPeriod={800}
            />
          )}
        </div>

        {/* Collapsible HUD Overlay */}
        <div className={`hero-hud ${overlayCollapsed ? 'collapsed' : ''}`}>
          <button className="hud-toggle" onClick={() => setOverlayCollapsed(p => !p)}>
            {overlayCollapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            {overlayCollapsed ? 'SHOW HUD' : 'HIDE HUD'}
          </button>
          {!overlayCollapsed && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="hud-panels">
              <div className="brand-card">
                <h1><Globe2 size={24} color="var(--accent)" /> SMART NEWS AND JOB TRACKER</h1>
                <p className="subtitle">Global Intelligence & Jobs Engine</p>
                <div className="status-line">
                  <span className={`dot ${loading ? 'red' : ''}`}></span>
                  {loading ? 'INITIALIZING...' : `TRACKING • ${allFiltered.length} NODES`}
                </div>
                {lastRefresh && <div className="refresh-line">↻ {lastRefresh.toLocaleTimeString()} • 10 min cycle</div>}
                {stats.totalJobs !== undefined && (
                  <div className="stats-bar">
                    <span className="stat-chip green"><Briefcase size={11} /> {stats.totalJobs}</span>
                    <span className="stat-chip red"><Newspaper size={11} /> {stats.totalNews}</span>
                    <span className="stat-chip blue"><Database size={11} /> {(stats.jobSources || 0) + (stats.newsSources || 0)} src</span>
                  </div>
                )}
              </div>
              <div className="controls-card">
                <div className="ctrl-title"><Layers size={13} /> LAYERS</div>
                <label className="chk"><input type="checkbox" checked={filters.jobs} onChange={() => handleFilterToggle('jobs')} /> Jobs</label>
                <label className="chk"><input type="checkbox" checked={filters.news} onChange={() => handleFilterToggle('news')} /> News</label>
                <div className="sep"></div>
                <div className="ctrl-title"><Search size={13} /> SEARCH</div>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <input type="text" className="search-input" placeholder="Search..." value={searchQuery}
                    onChange={e => { setSearchQuery(e.target.value); setCompanyNodes([]); setFeedPage(1); }} />
                  <button onClick={searchCompanyBranches} disabled={learningCompany || !searchQuery} className="deep-intel-btn">
                    {learningCompany ? '...' : 'Intel'}
                  </button>
                </div>
                <div className="sep"></div>
                <div className="ctrl-title"><Filter size={13} /> FILTERS</div>
                <label className="chk"><input type="checkbox" checked={filters.remote} onChange={() => handleFilterToggle('remote')} /> Remote</label>
                <label className="chk"><input type="checkbox" checked={filters.engineering} onChange={() => handleFilterToggle('engineering')} /> Engineering</label>
                <label className="chk"><input type="checkbox" checked={filters.enterprise} onChange={() => handleFilterToggle('enterprise')} /> Enterprise AI</label>
              </div>
            </motion.div>
          )}
        </div>
      </section>

      {/* ═══════ AI INSIGHTS ═══════ */}
      <motion.section initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="section ai-bar">
        <div className="ai-bar-inner">
          <div className="ai-header">
            <span><Bot size={18} /> AI Intelligence Brief</span>
            <span className="gemini-badge">Multi-Model Engine</span>
          </div>
          <div className="ai-text"><TypewriterText text={aiInsight} /></div>
        </div>
      </motion.section>

      {/* ═══════ TACTICAL FEED (Paginated) ═══════ */}
      {showSections.feed && (
        <motion.section initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="section">
          <div className="section-header">
            <h2><Radio size={20} color="var(--accent)" /> TACTICAL FEED</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className="count-badge">{allFiltered.length} nodes</span>
              <button className="collapse-btn" onClick={() => setShowSections(p => ({ ...p, feed: false }))}>Hide</button>
            </div>
          </div>
          <div className="feed-grid">
            {feedSlice.map((item) => (
              <div key={item.id} className={`feed-card ${item.type}`} onClick={() => handlePointClick(item)}>
                <div className="fc-top">
                  {item.type === 'job'
                    ? <span className="tag job"><Building2 size={12} /> {item.company}</span>
                    : <span className="tag news"><Zap size={12} /> {item.source}</span>}
                  <span className="fc-time">{item.time}</span>
                </div>
                <div className="fc-title">{item.type === 'job' ? item.title : item.headline}</div>
                <div className="fc-meta"><MapPin size={12} /> {item.location} {item.isRemote ? '(Remote)' : ''}</div>
              </div>
            ))}
          </div>
          <Pagination page={feedPage} totalPages={Math.ceil(allFiltered.length / FEED_PER_PAGE)} total={allFiltered.length}
            onPageChange={p => { setFeedPage(p); window.scrollTo({ top: 600, behavior: 'smooth' }); }} label={`Page ${feedPage}`} />
        </motion.section>
      )}
      {!showSections.feed && (
        <div className="section-expand"><button className="collapse-btn" onClick={() => setShowSections(p => ({ ...p, feed: true }))}>▶ Show Tactical Feed ({allFiltered.length})</button></div>
      )}

      {/* ═══════ LATEST TRENDS (Paginated) ═══════ */}
      {showSections.trends && (
        <motion.section initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="section trends-section">
          <div className="section-header">
            <h2><TrendingUp size={20} color="var(--accent)" /> LATEST TRENDS</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div className="trend-filters">
                {['all', 'ai', 'tech', 'research'].map(cat => (
                  <button key={cat} className={`trend-btn ${trendFilter === cat ? 'active' : ''}`}
                    onClick={() => { setTrendFilter(cat); setTrendPage(1); }}>
                    {cat === 'all' ? '🌐 All' : cat === 'ai' ? '🧠 AI' : cat === 'tech' ? '📱 Tech' : '🔬 Research'}
                  </button>
                ))}
              </div>
              <button className="collapse-btn" onClick={() => setShowSections(p => ({ ...p, trends: false }))}>Hide</button>
            </div>
          </div>
          <div className="trends-grid">
            {trendSlice.map((t) => (
              <a key={t.id} href={t.url} target="_blank" rel="noreferrer" className="trend-card">
                <div className="tc-source"><span className="tc-icon">{t.icon}</span> {t.source}</div>
                <div className="tc-title">{t.title}</div>
                <div className="tc-snippet">{t.snippet}</div>
                <div className="tc-footer"><ExternalLink size={12} /> Read More</div>
              </a>
            ))}
          </div>
          <Pagination page={trendPage} totalPages={Math.ceil(filteredTrends.length / TREND_PER_PAGE)} total={filteredTrends.length}
            onPageChange={p => setTrendPage(p)} label={`Page ${trendPage}`} />
        </motion.section>
      )}
      {!showSections.trends && (
        <div className="section-expand"><button className="collapse-btn" onClick={() => setShowSections(p => ({ ...p, trends: true }))}>▶ Show Trends ({trends.length})</button></div>
      )}

      {/* ═══════ VIDEOS (Paginated + Category Filter) ═══════ */}
      {showSections.videos && (
        <motion.section initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="section">
          <div className="section-header">
            <h2><Video size={20} color="var(--accent)" /> LIVE & TRENDING STREAMS</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div className="trend-filters">
                {['all', 'ai', 'tech', 'startup', 'security', 'cloud', 'web3'].map(cat => (
                  <button key={cat} className={`trend-btn ${videoFilter === cat ? 'active' : ''}`}
                    onClick={() => { setVideoFilter(cat); setVideoPage(1); }}>
                    {cat === 'all' ? '🌐' : cat === 'ai' ? '🧠' : cat === 'tech' ? '💻' : cat === 'startup' ? '🚀' : cat === 'security' ? '🔒' : cat === 'cloud' ? '☁️' : '⛓️'} {cat}
                  </button>
                ))}
              </div>
              <span className="count-badge">{filteredVideos.length} streams</span>
              <button className="collapse-btn" onClick={() => setShowSections(p => ({ ...p, videos: false }))}>Hide</button>
            </div>
          </div>
          <div className="video-grid">
            {videoSlice.map((v, i) => (
              <div className="vid-card" key={v.videoId || i}>
                <div className="vid-label"><span className="vid-dot"></span> {(v.channel || 'YT').toUpperCase()}</div>
                <iframe src={`https://www.youtube.com/embed/${v.videoId}?autoplay=0&mute=1`} allowFullScreen
                  style={{ border: 'none', width: '100%', height: '180px' }} title={v.title || `Stream ${i}`} loading="lazy" />
                <div className="vid-info">
                  <div className="vid-title">{v.title}</div>
                  {v.published && <div className="vid-date">{v.published}</div>}
                </div>
              </div>
            ))}
          </div>
          <Pagination page={videoPage} totalPages={Math.ceil(filteredVideos.length / VIDEO_PER_PAGE)} total={filteredVideos.length}
            onPageChange={p => setVideoPage(p)} label={`Page ${videoPage}`} />
        </motion.section>
      )}
      {!showSections.videos && (
        <div className="section-expand"><button className="collapse-btn" onClick={() => setShowSections(p => ({ ...p, videos: true }))}>▶ Show Videos ({videoQueries.length})</button></div>
      )}

      {/* ═══════ OPEN PORTAL BUTTON ═══════ */}
      <section className="section portal-banner">
        <button onClick={() => { setShowPortal(true); fetchPortalJobs(1, ''); }} className="portal-link">
          <Briefcase size={20} /> Open Smart Job Portal <ArrowUpRight size={14} />
        </button>
      </section>

      {/* ═══════ EMBEDDED SMART JOB PORTAL ═══════ */}
      <AnimatePresence>
        {showPortal && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="portal-overlay">
            <motion.div initial={{ scale: 0.95, y: 40 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 40 }} className="portal-container">
              <div className="portal-header">
                <h2><Briefcase size={22} color="var(--accent)" /> Smart Job Portal</h2>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="count-badge">{portalTotal} total jobs</span>
                  <button className="modal-close" onClick={() => setShowPortal(false)}><X size={20} /></button>
                </div>
              </div>
              <div className="portal-search-bar">
                <input type="text" className="portal-search" placeholder="Search jobs by title, company..." value={portalSearch}
                  onChange={e => setPortalSearch(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { setPortalPage(1); fetchPortalJobs(1, portalSearch); } }} />
                <button className="deep-intel-btn" onClick={() => { setPortalPage(1); fetchPortalJobs(1, portalSearch); }}>Search</button>
              </div>
              <div className="portal-jobs-list">
                {portalLoading && <div className="portal-loading">Loading jobs...</div>}
                {!portalLoading && portalJobs.length === 0 && <div className="portal-loading">No jobs found.</div>}
                {portalJobs.map((j, i) => (
                  <div key={j.id || i} className="portal-job-card">
                    <div className="pj-top">
                      <div className="pj-title">{j.title || 'Untitled'}</div>
                      <span className={`pj-status ${j.status || 'open'}`}>{j.status || 'open'}</span>
                    </div>
                    <div className="pj-company"><Building2 size={13} /> {j.company || 'Company'}</div>
                    <div className="pj-meta">
                      <span><MapPin size={12} /> {j.location || 'Remote'}</span>
                      <span>💰 {j.pay || 'N/A'}</span>
                      <span>📡 {j.source || 'Source'}</span>
                    </div>
                    <div className="pj-actions">
                      <a href={j.url || '#'} target="_blank" rel="noreferrer" className="pj-apply-btn">Apply <ExternalLink size={12} /></a>
                    </div>
                  </div>
                ))}
              </div>
              <Pagination page={portalPage} totalPages={portalTotalPages} total={portalTotal}
                onPageChange={p => { setPortalPage(p); fetchPortalJobs(p, portalSearch); }} label={`Page ${portalPage}`} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ═══════ DETAIL MODAL ═══════ */}
      <AnimatePresence>
        {selectedPoint && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="modal-overlay" onClick={() => setSelectedPoint(null)}>
            <motion.div initial={{ scale: 0.9, y: 30 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9, y: 30 }} className="modal-box" onClick={e => e.stopPropagation()}>
              <button className="modal-close" onClick={() => setSelectedPoint(null)}><X size={20} /></button>
              <div className="modal-tag" style={{ color: selectedPoint.type === 'job' ? '#00e676' : '#ff3333' }}>
                {selectedPoint.type === 'job' ? 'JOB INTELLIGENCE' : 'NEWS EVENT'}
              </div>
              <h3 className="modal-title">{selectedPoint.type === 'job' ? selectedPoint.title : selectedPoint.headline}</h3>
              <div className="modal-details">
                <div className="d-row"><span className="d-label">Entity:</span><span className="d-val">{selectedPoint.company || selectedPoint.source}</span></div>
                <div className="d-row"><span className="d-label">Location:</span><span className="d-val">{selectedPoint.location} {selectedPoint.isRemote ? '(Remote)' : ''}</span></div>
                <div className="d-row"><span className="d-label">Signal:</span><span className="d-val">{selectedPoint.time}</span></div>
                <div className="d-row"><span className="d-label">Coordinates:</span><span className="d-val">{selectedPoint.lat?.toFixed(4)}, {selectedPoint.lng?.toFixed(4)}</span></div>
              </div>
              <div className="modal-actions">
                {selectedPoint.type === 'job' ? (
                  <>
                    <a href={selectedPoint.url || '#'} target="_blank" rel="noreferrer" className="action-btn green">
                      <Briefcase size={16} /> Apply via Source <ExternalLink size={14} style={{ marginLeft: 'auto' }} />
                    </a>
                    <button className="action-btn portal-open-btn" onClick={() => { setSelectedPoint(null); setShowPortal(true); fetchPortalJobs(1, ''); }}>
                      <Briefcase size={16} /> Open in Portal
                    </button>
                  </>
                ) : (
                  <a href={selectedPoint.url || '#'} target="_blank" rel="noreferrer" className="action-btn red">
                    <Newspaper size={16} /> Read Full Report <ExternalLink size={14} style={{ marginLeft: 'auto' }} />
                  </a>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default App;
