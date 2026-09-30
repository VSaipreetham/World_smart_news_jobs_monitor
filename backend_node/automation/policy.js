'use strict';

const { createHash } = require('node:crypto');

const DEFAULT_FILTERS = Object.freeze({
  locations: ['Hyderabad'], keywords: ['AI', 'ML', 'GenAI', 'Machine Learning'],
  excludeKeywords: ['internship'], skills: ['Python', 'RAG', 'LangGraph'],
  companies: [], excludeCompanies: [], sources: [], workModes: [], employmentTypes: [],
  minSalaryLpa: 30, maxRequiredYears: 3, maxAgeDays: 30, minMatch: 45,
  includeUnknownSalary: true, includeUnknownExperience: true, includeUnknownDate: true,
  verifiedOnly: true,
});

const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const text = (value, limit = 50000) => String(value ?? '')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
  .replace(/\s+/g, ' ').trim().slice(0, limit);
const tokens = value => text(value).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}+#._-]*/gu) || [];
const escapeRE = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const contains = (haystack, needle) => new RegExp(`(^|[^a-z0-9])${escapeRE(text(needle).toLowerCase())}(?=$|[^a-z0-9])`, 'i').test(haystack);

// This is a URL validation policy, not a general-purpose fetch allowlist. Adapters
// construct their own fixed HTTPS API destinations and never fetch directory URLs.
function safeUrl(value) {
  try {
    const url = new URL(String(value));
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(host)) return null;
    if (/(^|\.)(localhost|local|internal|test|invalid|example)$/.test(host) || host.endsWith('.localhost')) return null;
    if (String(value).length > 2048) return null;
    return url.toString();
  } catch { return null; }
}

function canonicalUrl(value) {
  const safe = safeUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|source$|ref$|referrer$|gh_src$)/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/apply\/?$/i, '').replace(/\/$/, '') || '/';
  return url.toString();
}

function annualSalary(raw) {
  const supplied = raw.salary || raw.salaryRange;
  if (supplied && typeof supplied === 'object') {
    const currency = String(supplied.currency || '').toUpperCase();
    const interval = String(supplied.interval || supplied.period || '').toLowerCase();
    const low = Number(supplied.minLpa ?? supplied.min ?? supplied.minimum);
    const high = Number(supplied.maxLpa ?? supplied.max ?? supplied.maximum ?? low);
    const lpa = supplied.minLpa != null || supplied.maxLpa != null;
    if ((currency === 'INR' || lpa) && (lpa || /^(year|yearly|annual|annually|per-year)$/.test(interval)) && low > 0 && high >= low) {
      return { minLpa: lpa ? low : low / 100000, maxLpa: lpa ? high : high / 100000, currency: 'INR', verified: true, status: 'employer-published' };
    }
  }
  const pay = text(raw.pay || raw.salaryText || (typeof supplied === 'string' ? supplied : ''), 500);
  const match = pay.match(/(?:₹|INR\s*)?(\d+(?:\.\d+)?)\s*(?:[-–—]\s*(\d+(?:\.\d+)?)\s*)?(?:LPA|lakhs?\s*(?:per\s*(?:annum|year)|p\.?a\.?)?)/i);
  if (match && Number(match[1]) > 0 && Number(match[2] || match[1]) >= Number(match[1])) {
    return { minLpa: Number(match[1]), maxLpa: Number(match[2] || match[1]), currency: 'INR', verified: true, status: 'employer-published' };
  }
  return { minLpa: null, maxLpa: null, currency: null, verified: false, status: 'unverified' };
}

function normalizeJob(raw = {}, source = {}) {
  const url = canonicalUrl(raw.url || raw.jobUrl || raw.hostedUrl || raw.absolute_url || raw.applyUrl);
  if (!url) throw new Error('Job requires a public HTTPS application URL');
  const description = text(raw.description || raw.descriptionPlain || raw.content || '', 40000);
  const title = text(raw.title || raw.text, 250);
  if (!title) throw new Error('Job title is required');
  const location = text(typeof raw.location === 'object' ? raw.location?.name : raw.location || raw.categories?.location || '', 500);
  const years = Number(raw.minExperienceYears ?? raw.requiredYears);
  const inferred = [...description.matchAll(/(?:minimum(?:\s+of)?|at\s+least)?\s*(\d+(?:\.\d+)?)\s*(?:[-–—]\s*\d+(?:\.\d+)?)?\s*\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:professional\s+|relevant\s+|software\s+|industry\s+|hands.on\s+|work\s+)?experience/gi)].map(match => Number(match[1]));
  const requiredYears = raw.minExperienceYears != null || raw.requiredYears != null
    ? (Number.isFinite(years) && years >= 0 && years <= 60 ? years : null)
    : (inferred.length ? Math.max(...inferred) : null);
  const posted = raw.postedDate || raw.publishedAt || raw.posted_date || (raw.createdAt ? raw.createdAt : null);
  const postedDate = posted && Number.isFinite(new Date(posted).getTime()) ? new Date(posted).toISOString() : null;
  const verified = raw.verifiedAt || raw.verified_at;
  const verifiedAt = verified && Number.isFinite(new Date(verified).getTime()) ? new Date(verified).toISOString() : null;
  const mode = text(raw.workMode || raw.workplaceType || (raw.isRemote ? 'remote' : ''), 40).toLowerCase();
  const workMode = /hybrid/.test(mode) ? 'hybrid' : /remote/.test(mode) ? 'remote' : /onsite|on.site|office/.test(mode) ? 'onsite'
    : /hybrid/i.test(location) ? 'hybrid' : /remote/i.test(location) ? 'remote' : 'unknown';
  const salary = annualSalary(raw);
  return {
    id: hash(url), url, applyUrl: safeUrl(raw.applyUrl) || url, title, company: text(raw.company || source.name || 'Unknown employer', 200), location,
    description, requiredYears, minExperienceYears: requiredYears, postedDate, verifiedAt, workMode,
    employmentType: text(raw.employmentType || raw.categories?.commitment || '', 80).toLowerCase(),
    salary, salaryLpa: salary.verified ? { min: salary.minLpa, max: salary.maxLpa } : null, pay: text(raw.pay || raw.salaryText, 500),
    source: text(raw.source || source.name || source.provider || 'Imported', 150),
    provider: text(raw.provider || source.provider || 'manual', 50), board: text(raw.board || source.board || '', 150),
    externalId: text(raw.externalId || raw.id || '', 150),
  };
}

function sanitizeFilters(input = {}) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const result = {};
  for (const [key, defaultValue] of Object.entries(DEFAULT_FILTERS)) {
    if (Array.isArray(defaultValue)) {
      const list = value[key] == null ? defaultValue : Array.isArray(value[key]) ? value[key] : String(value[key]).split(',');
      result[key] = [...new Set(list.map(item => text(item, 120)).filter(Boolean))].slice(0, 50);
    } else if (typeof defaultValue === 'boolean') {
      result[key] = typeof value[key] === 'boolean' ? value[key] : defaultValue;
    } else {
      const bounds = { minSalaryLpa: 1000, maxRequiredYears: 60, maxAgeDays: 3650, minMatch: 100 };
      const number = value[key] == null || value[key] === '' ? defaultValue : Number(value[key]);
      result[key] = Number.isFinite(number) ? Math.max(0, Math.min(bounds[key], number)) : defaultValue;
    }
  }
  result.workModes = result.workModes.map(mode => mode.toLowerCase()).filter(mode => ['onsite', 'hybrid', 'remote', 'unknown'].includes(mode));
  return result;
}

function evaluateJob(job, input = {}, profile = {}, now = Date.now()) {
  const filters = sanitizeFilters(input);
  const body = `${job.title} ${job.description}`.toLowerCase();
  const reasons = [], warnings = [];
  const some = (haystack, list) => !list.length || list.some(item => contains(String(haystack).toLowerCase(), item));
  if (!some(job.location, filters.locations)) reasons.push('Location does not match');
  if (!some(body, filters.keywords)) reasons.push('Role keywords do not match');
  if (filters.excludeKeywords.some(item => contains(body, item))) reasons.push('Excluded role keyword');
  if (!some(job.company, filters.companies)) reasons.push('Employer is outside selected companies');
  if (filters.excludeCompanies.some(item => contains(job.company.toLowerCase(), item))) reasons.push('Excluded company');
  if (!some(job.source, filters.sources)) reasons.push('Source is outside selected sources');
  if (filters.workModes.length && !filters.workModes.includes(job.workMode)) reasons.push('Work mode does not match');
  if (filters.employmentTypes.length && !some(job.employmentType, filters.employmentTypes)) reasons.push('Employment type does not match');
  if (filters.verifiedOnly && !job.verifiedAt) reasons.push('Official source has not been verified');
  if (!job.salary?.verified || !Number.isFinite(job.salary?.maxLpa)) {
    warnings.push('Compensation unverified; target salary is not an employer offer');
    if (!filters.includeUnknownSalary) reasons.push('Employer salary is unknown');
  } else if (job.salary.maxLpa < filters.minSalaryLpa) reasons.push('Published salary is below the minimum');
  else if (job.salary.minLpa < filters.minSalaryLpa) warnings.push('Only part of the published salary range meets the target');
  if (job.requiredYears == null) {
    warnings.push('Numeric experience requirement is unknown');
    if (!filters.includeUnknownExperience) reasons.push('Experience requirement is unknown');
  } else if (job.requiredYears > filters.maxRequiredYears) reasons.push('Experience requirement exceeds the filter');
  const years = Number(profile.experienceYears ?? profile.experience_years);
  if (Number.isFinite(years) && job.requiredYears > years) warnings.push('Experience gap requires review');
  if (!job.postedDate) {
    warnings.push('Employer posting date is unknown; first seen is not a posting date');
    if (!filters.includeUnknownDate) reasons.push('Posting date is unknown');
  } else if ((now - new Date(job.postedDate).getTime()) / 86400000 > filters.maxAgeDays) reasons.push('Posting is older than the selected window');
  else if (new Date(job.postedDate).getTime() > now + 86400000) reasons.push('Posting date is in the future');
  const skills = [...new Set([...filters.skills, ...(Array.isArray(profile.skills) ? profile.skills : [])])];
  const matchedSkills = skills.filter(skill => contains(body, skill));
  const missingSkills = skills.filter(skill => !contains(body, skill));
  const resumeTokens = new Set(tokens(profile.resumeText || profile.resume_text || '').filter(token => token.length > 3));
  const jobTokens = new Set(tokens(body).filter(token => token.length > 3));
  const overlap = [...resumeTokens].filter(token => jobTokens.has(token)).length;
  const score = Math.min(99, Math.round(40 + (skills.length ? 40 * matchedSkills.length / skills.length : 0)
    + 15 * Math.min(1, overlap / 20) + (job.verifiedAt ? 4 : 0)));
  if (score < filters.minMatch) reasons.push('Evidence match score is below the selected threshold');
  const scoring = 'Keyword and résumé evidence overlap; not a hiring probability';
  return { eligible: reasons.length === 0, accepted: reasons.length === 0, matches: reasons.length === 0, score,
    reasons: [...(matchedSkills.length ? [`Skill evidence: ${matchedSkills.join(', ')}`] : []), ...(job.verifiedAt ? ['Official ATS listing checked'] : [])],
    failures: reasons, gaps: warnings, warnings, matchedSkills, missingSkills, scoring, scoreLabel: scoring, salaryVerified: Boolean(job.salary?.verified) };
}

module.exports = { DEFAULT_FILTERS, hash, text, tokens, safeUrl, canonicalUrl, normalizeJob, sanitizeFilters, evaluateJob, annualSalary };
