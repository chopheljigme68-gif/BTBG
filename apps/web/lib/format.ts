/** Display helpers. Dates are shown as DD/MM/YYYY in Bhutan Time (SRS 3.9.5). */
const TZ = 'Asia/Thimphu';

export function date(v?: string | Date | null) {
  if (!v) return '—';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-');
    return `${d}/${m}/${y}`;
  }
  const dt = new Date(v);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-GB', { timeZone: TZ });
}

export function dateTime(v?: string | Date | null) {
  if (!v) return '—';
  const dt = new Date(v);
  return `${dt.toLocaleDateString('en-GB', { timeZone: TZ })} ${dt.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })}`;
}

export function money(n?: number | string | null) {
  if (n === null || n === undefined || n === '') return '—';
  return `Nu ${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export function label(s?: string | null) {
  if (!s) return '—';
  return s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export function todayBT() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

export function relative(v?: string | Date | null) {
  if (!v) return '';
  const diff = (Date.now() - new Date(v).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} d ago`;
  return date(v);
}

/** Stable anonymous id for campaign analytics and visitor help tickets. */
export function viewerRef() {
  if (typeof window === 'undefined') return 'server';
  try {
    let r = localStorage.getItem('btbg_viewer');
    if (!r) {
      r = crypto.randomUUID().replace(/-/g, '');
      localStorage.setItem('btbg_viewer', r);
    }
    return r;
  } catch {
    return 'anonymous-viewer';
  }
}
