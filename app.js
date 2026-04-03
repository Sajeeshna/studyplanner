/**
 * ============================================================
 *  StudyPlanner v2.0 — Production Application
 *  Supabase-powered PWA | Multinational Quality Build
 * ============================================================
 *
 *  Architecture:
 *    CONFIG       → App-wide constants & environment config
 *    AppState     → Single-source-of-truth state machine
 *    DOM          → Typed element accessors + creation helpers
 *    Toast        → Non-blocking notification system
 *    Auth         → Authentication (Email/Password + Google OAuth)
 *    Router       → Section navigation
 *    Dashboard    → Stats, streak, study-time summary
 *    Timetable    → Read-only exam schedule (admin-managed)
 *    Reminders    → Recurring deadline tracker
 *    Notes        → Tagged digital notes with search
 *    SemNotes     → Semester-organised notes & admin PDFs
 *    Pomodoro     → 25/5/15 focus timer with SVG ring
 *    Tasks        → Daily checklist with progress bar
 *    Flashcards   → Flip-card study deck
 *    Progress     → CGPA tracker with Chart.js bar chart
 *    Attendance   → Per-subject class tracker
 *    Profile      → Student profile form
 *    Export       → CSV data export
 *    Settings     → Theme, API-key management
 *    Chatbot      → Gemini-powered AI study assistant
 *    Admin        → Admin-only timetable / PDF / user management
 *    Confetti     → Completion celebration effect
 *    Keyboard     → Global keyboard shortcut handler
 *    PWA          → Service-worker registration
 */

'use strict';

/** Simple debounce helper for search inputs */
function _debounce(fn, ms = 250) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

/* ─────────────────────────────────────────────────────────────
   SECTION 1 — CONFIGURATION
   ───────────────────────────────────────────────────────────── */

const CONFIG = Object.freeze({
  SUPABASE_URL: 'https://twynkveodyirtdmxhskk.supabase.co',
  SUPABASE_KEY: 'sb_publishable_M-fl8590-ZqAnYY6Y1o1QA_kqhWs48U',
  ADMIN_EMAIL: 'msajeeshna@gmail.com',
  AUTH_TIMEOUT: 3000,   // ms – safety net before forcing auth screen
  TOAST_DURATION: 3500,  // ms
  POMO_MODES: Object.freeze({ study: 1500, break: 300, longbreak: 900 }),
  SEMESTER_SUBJECTS: Object.freeze({
    1: ['Maths', 'Physics', 'Chemistry', 'PSP'],
    2: ['Maths', 'Physics', 'Fee', 'English', 'EVS'],
    3: ['DCF', 'Program C', 'System Administration', 'Computer Network 1'],
    4: ['Computer Network 2', 'Java', 'Embedded System'],
    5: ['Elective 1', 'Core Subject'],
    6: ['Elective 2', 'Project'],
  }),
  GEMINI_MODEL: 'gemini-2.0-flash',
  // Gemini API key is stored securely in Supabase Edge Function secrets — NOT here.
  MAX_PDF_BYTES: 15 * 1024 * 1024,  // 15 MB
});


/* ─────────────────────────────────────────────────────────────
   SECTION 2 — SUPABASE CLIENT
   ───────────────────────────────────────────────────────────── */

if (typeof supabase === 'undefined') {
  // CDN unavailable – surface the auth screen via DOMContentLoaded
  document.addEventListener('DOMContentLoaded', () => {
    AppState.switchScreen('auth');
  });
  throw new Error('[StudyPlanner] Supabase CDN failed. Check network connectivity.');
}

const supa = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);


/* ─────────────────────────────────────────────────────────────
   SECTION 3 — APPLICATION STATE MACHINE
   Single source of truth. No other code should touch
   #loading-screen / #login-screen / #app-container directly.
   ───────────────────────────────────────────────────────────── */

const AppState = (() => {
  /** @type {'loading'|'auth'|'app'} */
  let _current = 'loading';
  let _safetyTimer = null;

  const els = () => ({
    loading: document.getElementById('loading-screen'),
    login: document.getElementById('login-screen'),
    app: document.getElementById('app-container'),
  });

  /**
   * Transition to a named screen.
   * @param {'loading'|'auth'|'app'} screen
   */
  function switchScreen(screen) {
    if (_current === screen) return;
    _current = screen;

    const { loading, login, app } = els();

    // Always dismiss the loading overlay
    if (loading && !loading.classList.contains('fade-out')) {
      loading.classList.add('fade-out');
      loading.setAttribute('aria-hidden', 'true');
      // Remove from layout after CSS transition completes (900ms)
      setTimeout(() => { if (loading) loading.style.display = 'none'; }, 900);
    }

    if (screen === 'auth') {
      login?.classList.remove('hidden');
      login?.removeAttribute('aria-hidden');
      app?.classList.remove('show');
      // Move focus to first focusable element in login form
      setTimeout(() => document.getElementById('auth-email')?.focus(), 520);
    } else if (screen === 'app') {
      login?.classList.add('hidden');
      login?.setAttribute('aria-hidden', 'true');
      app?.classList.add('show');
    }
  }

  /** Arm the safety net – shows auth screen if still loading after CONFIG.AUTH_TIMEOUT */
  function armSafetyNet() {
    clearTimeout(_safetyTimer);
    _safetyTimer = setTimeout(() => {
      if (_current === 'loading') {
        console.warn('[StudyPlanner] Auth timeout – forcing login screen.');
        switchScreen('auth');
      }
    }, CONFIG.AUTH_TIMEOUT);
  }

  function disarmSafetyNet() {
    clearTimeout(_safetyTimer);
  }

  function current() { return _current; }

  return Object.freeze({ switchScreen, armSafetyNet, disarmSafetyNet, current });
})();


/* ─────────────────────────────────────────────────────────────
   SECTION 4 — APPLICATION RUNTIME STATE
   ───────────────────────────────────────────────────────────── */

let currentUser = null;
let progressChart = null;
let appInitialized = false;
let tasksInitialized = false;

const isAdmin = () => currentUser?.email === CONFIG.ADMIN_EMAIL;


/* ─────────────────────────────────────────────────────────────
   SECTION 5 — DOM UTILITIES
   ───────────────────────────────────────────────────────────── */

/**
 * HTML-escape a string to prevent XSS.
 * @param {unknown} str
 * @returns {string}
 */
function esc(str) {
  if (str == null) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

/**
 * Create a DOM element with attributes and children.
 * @param {string} tag
 * @param {Record<string, unknown>} [attrs={}]
 * @param {(Node|string)[]} [children=[]]
 * @returns {HTMLElement}
 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    switch (key) {
      case 'className': node.className = value; break;
      case 'textContent': node.textContent = String(value); break;
      case 'innerHTML': node.innerHTML = value; break;
      case 'style':
        if (typeof value === 'object') Object.assign(node.style, value);
        else node.style.cssText = value;
        break;
      default:
        if (key.startsWith('on')) {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else {
          node.setAttribute(key, value);
        }
    }
  }

  for (const child of children) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string'
      ? document.createTextNode(child)
      : child);
  }

  return node;
}

/** Retrieve a required DOM element, logging a warning if absent. */
function getEl(id) {
  const node = document.getElementById(id);
  if (!node) console.warn(`[StudyPlanner] Element #${id} not found.`);
  return node;
}


/* ─────────────────────────────────────────────────────────────
   SECTION 6 — TOAST NOTIFICATION SYSTEM
   ───────────────────────────────────────────────────────────── */

const Toast = (() => {
  const ICONS = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };

  /**
   * Display a toast notification.
   * @param {string} message
   * @param {'success'|'error'|'warning'|'info'} [type='success']
   */
  function show(message, type = 'success') {
    const container = getEl('toast-container');
    if (!container) return;

    const toast = el('div', {
      className: `toast ${type}`,
      role: 'alert',
      'aria-live': 'polite',
    }, [
      el('span', { className: 't-icon', textContent: ICONS[type] ?? '✅' }),
      el('span', { className: 't-msg', textContent: message }),
      el('button', {
        className: 't-close',
        textContent: '✕',
        'aria-label': 'Dismiss notification',
        onClick: () => _remove(toast),
      }),
    ]);

    container.appendChild(toast);
    setTimeout(() => _remove(toast), CONFIG.TOAST_DURATION);
  }

  function _remove(toast) {
    if (!toast.parentElement) return;
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 300);
  }

  return Object.freeze({ show });
})();

// Convenience alias kept for backward compatibility
function showToast(msg, type) { Toast.show(msg, type); }


/* ─────────────────────────────────────────────────────────────
   SECTION 7 — CONFETTI
   ───────────────────────────────────────────────────────────── */

function triggerConfetti() {
  const COLORS = ['#ff6f61', '#4db6ac', '#7c4dff', '#448aff', '#ffb300', '#66bb6a', '#ff8a80'];
  const container = el('div', { className: 'confetti-container', 'aria-hidden': 'true' });
  document.body.appendChild(container);

  for (let i = 0; i < 80; i++) {
    const size = 6 + Math.random() * 8;
    const piece = el('div', {
      className: 'confetti-piece',
      style: {
        left: `${Math.random() * 100}vw`,
        background: COLORS[Math.floor(Math.random() * COLORS.length)],
        animationDelay: `${Math.random() * 2}s`,
        animationDuration: `${2 + Math.random() * 2}s`,
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: Math.random() > 0.5 ? '50%' : '2px',
      },
    });
    container.appendChild(piece);
  }

  setTimeout(() => container.remove(), 5000);
}


/* ─────────────────────────────────────────────────────────────
   SECTION 8 — AUTHENTICATION
   ───────────────────────────────────────────────────────────── */

let _isSignUp = false;

/** Toggle between Sign-In and Sign-Up forms. */
function toggleAuthMode() {
  _isSignUp = !_isSignUp;
  const nameInput = getEl('auth-name');
  const btn = getEl('auth-btn');
  const toggleText = getEl('toggle-text');
  const toggleLink = getEl('toggle-link');
  const errEl = getEl('auth-error');

  if (nameInput) nameInput.style.display = _isSignUp ? 'block' : 'none';
  if (btn) btn.textContent = _isSignUp ? 'Sign Up' : 'Sign In';
  if (toggleText) toggleText.textContent = _isSignUp
    ? 'Already have an account?'
    : "Don't have an account?";
  if (toggleLink) toggleLink.textContent = _isSignUp ? 'Sign In' : 'Sign Up';
  if (errEl) errEl.textContent = '';
}

/** Initiate Google OAuth sign-in. */
async function loginWithGoogle() {
  const { error } = await supa.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.href },
  });
  if (error) Toast.show(`Google sign-in failed: ${error.message}`, 'error');
}

/** Handle email/password sign-in or sign-up. */
async function handleAuth() {
  const email = getEl('auth-email')?.value.trim() ?? '';
  const password = getEl('auth-password')?.value ?? '';
  const errEl = getEl('auth-error');

  if (errEl) errEl.textContent = '';

  if (!email || !password) {
    Toast.show('Please fill in all fields.', 'warning');
    return;
  }

  const btn = getEl('auth-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Please wait…'; }

  try {
    if (_isSignUp) {
      const name = getEl('auth-name')?.value.trim() ?? '';
      if (!name) {
        Toast.show('Please enter your name.', 'warning');
        if (btn) { btn.disabled = false; btn.textContent = 'Sign Up'; }
        return;
      }

      const { error } = await supa.auth.signUp({
        email, password,
        options: { data: { name } },
      });

      if (error) {
        if (errEl) errEl.textContent = error.message;
      } else {
        Toast.show('Account created! Check your email to verify, then sign in.', 'success');
      }
    } else {
      const { error } = await supa.auth.signInWithPassword({ email, password });
      if (error) {
        if (errEl) errEl.textContent = error.message;
        Toast.show('Sign-in failed. Please check your credentials.', 'error');
      }
    }
  } catch (err) {
    console.error('[Auth] Unexpected error:', err);
    Toast.show('Network error. Please try again.', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = _isSignUp ? 'Sign Up' : 'Sign In';
    }
  }
}

/** Sign out the current user and reset runtime state. */
async function logoutUser() {
  // Clear Pomodoro timer to prevent orphaned intervals
  clearInterval(_pomoInterval);
  _pomoRunning = false;
  tasksInitialized = false;
  appInitialized = false;
  currentUser = null;
  await supa.auth.signOut();
}

/**
 * Central auth-state listener — the ONLY mechanism that transitions
 * between the loading, auth, and app screens.
 */
supa.auth.onAuthStateChange((event, session) => {
  AppState.disarmSafetyNet();

  // Clear OAuth hash fragments from URL to prevent loop/stuck states
  if (window.location.hash && window.location.hash.includes('access_token')) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  if (session?.user) {
    currentUser = session.user;
    AppState.switchScreen('app');

    const meta = currentUser.user_metadata ?? {};
    const displayName = meta.name ?? meta.full_name ?? currentUser.email.split('@')[0];

    const nameEl = getEl('user-display-name');
    const avatarEl = getEl('avatar');
    if (nameEl) nameEl.textContent = displayName;
    if (avatarEl) avatarEl.textContent = displayName.charAt(0).toUpperCase();

    if (!appInitialized) {
      appInitialized = true;
      if (isAdmin()) {
        if (nameEl) nameEl.textContent = '👑 Admin';
        if (avatarEl) avatarEl.textContent = 'A';
        initAdminApp();
      } else {
        initApp();
      }
    }
  } else {
    currentUser = null;
    appInitialized = false;
    tasksInitialized = false;
    AppState.switchScreen('auth');
  }
});

// Safety net – arm on page load, disarm in onAuthStateChange
window.addEventListener('load', () => {
  AppState.armSafetyNet();
});


/* ─────────────────────────────────────────────────────────────
   SECTION 9 — APP BOOTSTRAP
   ───────────────────────────────────────────────────────────── */

function initApp() {
  // Date greeting
  const heroDate = getEl('hero-date');
  if (heroDate) {
    heroDate.textContent = new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
  }

  getEl('sidebar')?.style.setProperty('display', 'block');
  getEl('admin-sidebar')?.style.setProperty('display', 'none');

  // Restore theme preference
  _applyTheme(localStorage.getItem('sp-theme') ?? 'light');

  // Ensure chatbot FAB is visible for students; pre-open chat area
  const _fab = getEl('chatbot-fab');
  const _win = getEl('chatbot-window');
  if (_fab) _fab.style.display = 'flex';
  if (_win) _win.style.display = '';
  _initChatbot();

  initChart();

  // Load all feature data in parallel (non-blocking)
  Promise.allSettled([
    loadAdminNotes(), loadExams(), loadReminders(), loadNotes(),
    loadUserSemNotes(), loadProgress(), loadProfile(), loadTasks(),
    loadFlashcards(), loadAttendance(), loadStudyStreak(), loadStudyTime(),
    loadStudyRequests(),
  ]).then(() => updateDashboard());

  navigateTo('dashboard');
  recordStreak();
}

function initAdminApp() {
  getEl('sidebar')?.style.setProperty('display', 'none');
  getEl('admin-sidebar')?.style.setProperty('display', 'block');

  document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.admin-sidebar-item').forEach(s => s.classList.remove('active'));

  getEl('section-admin')?.classList.add('active');
  document.querySelector('.admin-sidebar-item[data-section="admin"]')?.classList.add('active');

  _applyTheme(localStorage.getItem('sp-theme') ?? 'light');

  // Admin has no chatbot — hide it
  const _f = getEl('chatbot-fab');
  const _w = getEl('chatbot-window');
  if (_f) _f.style.display = 'none';
  if (_w) _w.style.display = 'none';

  Promise.allSettled([
    adminLoadPdfs(), adminLoadUsers(),
    adminLoadStudentReports(), adminLoadAttendancePanel(),
    adminLoadStudyRequests(),
  ]);
}

function _applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : '');
  const btn = getEl('theme-toggle');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}


/* ─────────────────────────────────────────────────────────────
   SECTION 10 — DARK MODE
   ───────────────────────────────────────────────────────────── */

function toggleDarkMode() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const next = isDark ? 'light' : 'dark';
  _applyTheme(next);
  localStorage.setItem('sp-theme', next);
}


/* ─────────────────────────────────────────────────────────────
   SECTION 11 — NAVIGATION / ROUTER
   ───────────────────────────────────────────────────────────── */

function navigateTo(sectionId) {
  document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.sidebar-item').forEach(s => s.classList.remove('active'));

  getEl(`section-${sectionId}`)?.classList.add('active');
  document.querySelector(`.sidebar-item[data-section="${sectionId}"]`)?.classList.add('active');

  // Close mobile sidebar
  getEl('sidebar')?.classList.remove('open');
  getEl('sidebar-overlay')?.classList.remove('show');
}

function adminNavigateTo(sectionId) {
  document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.admin-sidebar-item').forEach(s => s.classList.remove('active'));

  getEl(`section-${sectionId}`)?.classList.add('active');
  document.querySelector(`.admin-sidebar-item[data-section="${sectionId}"]`)?.classList.add('active');

  getEl('admin-sidebar')?.classList.remove('open');
  getEl('sidebar-overlay')?.classList.remove('show');
}

function toggleMobileSidebar() {
  const sidebar = isAdmin()
    ? getEl('admin-sidebar')
    : getEl('sidebar');

  sidebar?.classList.toggle('open');
  getEl('sidebar-overlay')?.classList.toggle('show');
}


/* ─────────────────────────────────────────────────────────────
   SECTION 12 — DASHBOARD
   ───────────────────────────────────────────────────────────── */

async function updateDashboard() {
  if (!currentUser) return;

  try {
    const [tasks, reminders, progress, flashcards] = await Promise.all([
      supa.from('tasks').select('done').eq('user_id', currentUser.id),
      supa.from('reminders').select('date').eq('user_id', currentUser.id),
      supa.from('progress').select('marks').eq('user_id', currentUser.id),
      supa.from('flashcards').select('id', { count: 'exact', head: true }).eq('user_id', currentUser.id),
    ]);

    if (tasks.data) {
      const done = tasks.data.filter(t => t.done).length;
      const total = tasks.data.length;
      const dashTasks = getEl('dash-tasks');
      if (dashTasks) dashTasks.textContent = total > 0 ? `${done}/${total}` : '0';
    }

    if (reminders.data) {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const upcoming = reminders.data.filter(r => {
        const diff = Math.ceil((new Date(r.date) - today) / 86_400_000);
        return diff >= 0 && diff <= 7;
      }).length;
      const dashRem = getEl('dash-reminders');
      if (dashRem) dashRem.textContent = upcoming;
    }

    if (progress.data?.length > 0) {
      const avg = progress.data.reduce((s, r) => s + r.marks, 0) / progress.data.length;
      const cgpa = getEl('dash-cgpa');
      if (cgpa) cgpa.textContent = avg.toFixed(2);
    } else {
      const cgpa = getEl('dash-cgpa');
      if (cgpa) cgpa.textContent = '—';
    }

    const dashFC = getEl('dash-flashcards');
    if (dashFC) dashFC.textContent = flashcards.count ?? 0;
  } catch (err) {
    console.error('[Dashboard] updateDashboard error:', err);
  }
}


/* ─────────────────────────────────────────────────────────────
   SECTION 13 — STUDY STREAK
   ───────────────────────────────────────────────────────────── */

async function recordStreak() {
  if (!currentUser) return;
  try {
    const today = new Date().toISOString().split('T')[0];
    await supa.from('streak_log')
      .upsert({ user_id: currentUser.id, date: today }, { onConflict: 'user_id,date' });
  } catch (err) {
    console.error('[Streak] recordStreak error:', err);
  }
}

async function loadStudyStreak() {
  if (!currentUser) return;

  const { data } = await supa.from('streak_log')
    .select('date')
    .eq('user_id', currentUser.id)
    .order('date', { ascending: false });

  if (!data) return;

  let streak = 0;
  const cursor = new Date();
  const dateSet = new Set(data.map(r => r.date));

  for (let i = 0; i < 365; i++) {
    const dateStr = cursor.toISOString().split('T')[0];
    if (dateSet.has(dateStr)) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }

  const dashStreak = getEl('dash-streak');
  const streakDisplay = getEl('streak-count-display');
  if (dashStreak) dashStreak.textContent = streak;
  if (streakDisplay) streakDisplay.textContent = streak;
}


/* ─────────────────────────────────────────────────────────────
   SECTION 14 — STUDY TIME LOGGER
   ───────────────────────────────────────────────────────────── */

async function loadStudyTime() {
  if (!currentUser) return;
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data } = await supa.from('study_time')
      .select('subject, minutes')
      .eq('user_id', currentUser.id)
      .eq('date', today);
    _renderStudyTime(data ?? []);
  } catch (err) {
    console.error('[StudyTime] loadStudyTime error:', err);
  }
}

async function logStudyTime(subject, minutes) {
  if (!subject || !minutes || !currentUser) return;
  try {
    const today = new Date().toISOString().split('T')[0];

    const { data } = await supa.from('study_time')
      .select('id, minutes')
      .eq('user_id', currentUser.id)
      .eq('date', today)
      .eq('subject', subject)
      .maybeSingle();

    if (data) {
      await supa.from('study_time').update({ minutes: data.minutes + minutes }).eq('id', data.id);
    } else {
      await supa.from('study_time').insert({ user_id: currentUser.id, date: today, subject, minutes });
    }

    loadStudyTime();
  } catch (err) {
    console.error('[StudyTime] logStudyTime error:', err);
  }
}

function _renderStudyTime(rows) {
  const container = getEl('study-time-log');
  if (!container) return;
  container.innerHTML = '';

  if (!rows.length) {
    container.textContent = 'No study time logged today. Use the Pomodoro timer to start!';
    Object.assign(container.style, { color: 'var(--text-muted)', fontSize: '0.88rem' });
    return;
  }

  container.style.color = '';
  container.style.fontSize = '';

  rows.forEach(row => {
    const hours = Math.floor(row.minutes / 60);
    const mins = row.minutes % 60;
    const label = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

    container.appendChild(el('div', { className: 'task-item' }, [
      el('span', { textContent: '📖', style: { fontSize: '1.2rem' } }),
      el('span', { textContent: row.subject }),
      el('span', { textContent: label, style: { fontWeight: '600', color: 'var(--primary-main)' } }),
    ]));
  });
}


/* ─────────────────────────────────────────────────────────────
   SECTION 15 — EXAM TIMETABLE (user-managed)
   ───────────────────────────────────────────────────────────── */

async function addExam() {
  if (!currentUser) return;
  const day = getEl('exam-day')?.value.trim() ?? '';
  const time = getEl('exam-time')?.value ?? '';
  const subject = getEl('exam-subject')?.value.trim() ?? '';
  const date = getEl('exam-date')?.value ?? '';

  if (!day || !time || !subject) {
    Toast.show('Please fill in all exam fields.', 'warning');
    return;
  }

  const { error } = await supa.from('admin_timetable').insert({ day, time, subject, date, user_id: currentUser.id });
  if (error) { Toast.show(`Error: ${error.message}`, 'error'); return; }

  ['exam-day', 'exam-time', 'exam-subject', 'exam-date'].forEach(id => {
    const e = getEl(id); if (e) e.value = '';
  });

  Toast.show('Exam added! 📅');
  loadExams();
}

async function loadExams() {
  if (!currentUser) return;
  const { data, error } = await supa.from('admin_timetable')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('created_at');
  const tbody = getEl('exam-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (error || !data?.length) {
    tbody.appendChild(el('tr', {}, [
      el('td', {
        colSpan: '5',
        textContent: 'No exams scheduled yet.',
        style: { textAlign: 'center', color: 'var(--text-muted)', padding: '20px' },
      }),
    ]));
    return;
  }

  data.forEach(row => tbody.appendChild(el('tr', {}, [
    el('td', { textContent: row.day }),
    el('td', { textContent: row.time }),
    el('td', { textContent: row.subject }),
    el('td', { textContent: row.date ?? '—' }),
    el('td', {}, [
      el('button', {
        className: 'btn-delete',
        textContent: 'Delete',
        'aria-label': `Delete ${row.subject} exam`,
        onClick: async () => {
          await supa.from('admin_timetable').delete().eq('id', row.id);
          Toast.show('Exam removed.', 'warning');
          loadExams();
        },
      }),
    ]),
  ])));
}



/* ─────────────────────────────────────────────────────────────
   SECTION 16 — REMINDERS
   ───────────────────────────────────────────────────────────── */

async function addReminder() {
  if (!currentUser) return;
  const title = getEl('reminder-title')?.value.trim() ?? '';
  const date = getEl('reminder-date')?.value ?? '';
  const recurring = getEl('reminder-recurring')?.value ?? 'none';

  if (!title || !date) { Toast.show('Please fill in all reminder details.', 'warning'); return; }

  const { error } = await supa.from('reminders')
    .insert({ user_id: currentUser.id, title, date, recurring });

  if (error) { Toast.show(`Failed to save: ${error.message}`, 'error'); return; }

  getEl('reminder-title').value = '';
  getEl('reminder-date').value = '';
  Toast.show('Reminder set! 🔔');
  loadReminders();
  updateDashboard();
}

async function loadReminders() {
  if (!currentUser) return;
  const { data } = await supa.from('reminders')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('date');

  const list = getEl('reminder-list');
  if (!list) return;
  list.innerHTML = '';

  (data ?? []).forEach(d => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diffDays = Math.ceil((new Date(d.date) - today) / 86_400_000);
    const [statusClass, statusText] =
      diffDays <= 1 ? ['status-danger', 'URGENT']
        : diffDays <= 4 ? ['status-alert', 'ALERT']
          : ['status-safe', 'SAFE'];

    const recurText = d.recurring && d.recurring !== 'none'
      ? ` · Repeats ${d.recurring}` : '';

    list.appendChild(el('li', {}, [
      el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, [
        el('b', { textContent: d.title }),
        el('button', {
          className: 'btn-delete',
          textContent: 'Delete',
          'aria-label': `Delete reminder: ${d.title}`,
          onClick: async () => {
            await supa.from('reminders').delete().eq('id', d.id);
            loadReminders();
            updateDashboard();
          },
        }),
      ]),
      el('div', {
        style: { fontSize: '0.82rem', color: 'var(--text-muted)' },
        textContent: `${d.date} · ${diffDays} day${diffDays !== 1 ? 's' : ''} left${recurText}`,
      }),
      el('div', { className: statusClass, textContent: statusText }),
    ]));
  });
}


/* ─────────────────────────────────────────────────────────────
   SECTION 17 — DIGITAL NOTES
   ───────────────────────────────────────────────────────────── */

async function addNote() {
  if (!currentUser) return;
  const title = getEl('note-title')?.value.trim() ?? '';
  const content = getEl('note-content')?.value ?? '';
  const link = getEl('note-link')?.value.trim() ?? '';
  const tags = getEl('note-tags')?.value.trim() ?? '';

  if (!title) { Toast.show('Please enter a note title.', 'warning'); return; }

  const { error } = await supa.from('notes')
    .insert({ user_id: currentUser.id, title, content, link, tags });

  if (error) { Toast.show(`Error saving note: ${error.message}`, 'error'); return; }

  ['note-title', 'note-content', 'note-link', 'note-tags'].forEach(id => {
    const e = getEl(id); if (e) e.value = '';
  });

  Toast.show('Note saved! 📝');
  loadNotes();
}

async function loadNotes() {
  if (!currentUser) return;
  const { data } = await supa.from('notes')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false });

  const container = getEl('notes-container');
  if (!container) return;
  container.innerHTML = '';

  (data ?? []).forEach(d => {
    const noteDiv = el('div', {
      className: 'note-card',
      style: {
        background: 'var(--bg-gray)',
        borderLeft: '4px solid var(--primary-main)',
        padding: '12px',
        marginTop: '8px',
        borderRadius: '0 10px 10px 0',
        position: 'relative',
      },
    }, [
      el('button', {
        className: 'btn-delete',
        style: { position: 'absolute', top: '8px', right: '8px' },
        textContent: 'Delete',
        'aria-label': `Delete note: ${d.title}`,
        onClick: async () => {
          await supa.from('notes').delete().eq('id', d.id);
          loadNotes();
        },
      }),
      el('h4', { style: { fontSize: '0.95rem', paddingRight: '60px' }, textContent: d.title }),
      el('p', { style: { fontSize: '0.88rem', color: 'var(--text-muted)', marginTop: '4px' }, textContent: d.content ?? '' }),
    ]);

    if (d.tags) {
      const tagsDiv = el('div', { style: { marginTop: '6px' } });
      d.tags.split(',').forEach(t => tagsDiv.appendChild(
        el('span', { className: 'tag', textContent: `#${t.trim()}` })
      ));
      noteDiv.appendChild(tagsDiv);
    }

    if (d.link) {
      noteDiv.appendChild(el('a', {
        href: d.link, target: '_blank', rel: 'noopener noreferrer',
        style: { color: 'var(--primary-main)', fontSize: '0.82rem', display: 'inline-block', marginTop: '6px' },
        textContent: '🔗 View Link',
      }));
    }

    container.appendChild(noteDiv);
  });
}

/** Live search across note text content (client-side, no re-fetch). Debounced. */
const searchNotes = _debounce(() => {
  const query = getEl('note-search-input')?.value.toLowerCase() ?? '';
  const items = getEl('notes-container')?.children ?? [];
  Array.from(items).forEach(item => {
    item.style.display = item.textContent.toLowerCase().includes(query) ? '' : 'none';
  });
});


/* ─────────────────────────────────────────────────────────────
   SECTION 18 — SEMESTER NOTES
   ───────────────────────────────────────────────────────────── */

async function loadAdminNotes() {
  const sem = getEl('sem-select')?.value ?? '1';

  // Admin PDFs
  const { data: pdfs } = await supa.from('admin_pdfs')
    .select('*')
    .eq('sem', sem)
    .order('uploaded_at', { ascending: false });

  const pdfContainer = getEl('pdf-files-container');
  if (pdfContainer) {
    pdfContainer.innerHTML = '';
    if (!pdfs?.length) {
      pdfContainer.appendChild(el('p', {
        style: { color: 'var(--text-muted)', fontSize: '0.85rem', textAlign: 'center', marginTop: '8px' },
        textContent: 'No PDFs uploaded for this semester yet.',
      }));
    } else {
      pdfs.forEach(d => {
        const sizeStr = d.size > 1_048_576
          ? `${(d.size / 1_048_576).toFixed(1)} MB`
          : `${Math.round(d.size / 1024)} KB`;

        pdfContainer.appendChild(el('div', { className: 'pdf-item' }, [
          el('div', { className: 'pdf-icon', textContent: '📕' }),
          el('div', { className: 'pdf-info' }, [
            el('div', { className: 'pdf-name', textContent: d.name }),
            el('div', { className: 'pdf-meta', textContent: `${d.subject} · ${sizeStr}` }),
          ]),
          el('div', { className: 'pdf-actions' }, [
            el('a', { href: d.url, target: '_blank', rel: 'noopener noreferrer', className: 'btn-download', textContent: '📥 Download' }),
          ]),
        ]));
      });
    }
  }

  // Populate subject dropdowns for selected semester
  const subjects = CONFIG.SEMESTER_SUBJECTS[sem] ?? [];
  const subjectSel = getEl('subject-select');
  const pomoSubject = getEl('pomo-subject');

  if (subjectSel) subjectSel.innerHTML = '';
  if (pomoSubject) pomoSubject.innerHTML = '<option value="">General</option>';

  subjects.forEach(s => {
    if (subjectSel) subjectSel.appendChild(el('option', { value: s, textContent: s }));
    if (pomoSubject) pomoSubject.appendChild(el('option', { value: s, textContent: s }));
  });

  loadUserSemNotes();
}

async function addUserNote() {
  if (!currentUser) return;
  const sem = getEl('sem-select')?.value ?? '1';
  const subject = getEl('subject-select')?.value ?? '';
  const content = getEl('sem-note-content')?.value ?? '';

  if (!content.trim()) { Toast.show('Please write some notes first.', 'warning'); return; }

  await supa.from('sem_notes')
    .insert({ user_id: currentUser.id, sem, subject, content });

  const noteContent = getEl('sem-note-content');
  if (noteContent) noteContent.value = '';

  Toast.show(`Note saved for ${subject}!`);
  loadUserSemNotes();
}

async function loadUserSemNotes() {
  if (!currentUser) return;
  const { data } = await supa.from('sem_notes')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false });

  const container = getEl('user-sem-notes');
  if (!container) return;
  container.innerHTML = '';

  (data ?? []).forEach(d => {
    container.appendChild(el('div', {
      style: {
        background: 'rgba(255,152,0,0.08)',
        borderLeft: '4px solid #ff9800',
        padding: '12px',
        marginTop: '8px',
        borderRadius: '0 10px 10px 0',
        position: 'relative',
      },
    }, [
      el('button', {
        className: 'btn-delete',
        style: { position: 'absolute', top: '8px', right: '8px' },
        textContent: 'Delete',
        'aria-label': `Delete note for ${d.subject}`,
        onClick: async () => {
          await supa.from('sem_notes').delete().eq('id', d.id);
          loadUserSemNotes();
        },
      }),
      el('span', {
        style: { fontSize: '0.68rem', background: '#ff9800', color: '#fff', padding: '2px 8px', borderRadius: '6px', fontWeight: '600' },
        textContent: 'MY NOTE',
      }),
      el('strong', { style: { marginLeft: '6px' }, textContent: `S${d.sem} – ${d.subject}` }),
      el('p', { style: { fontSize: '0.88rem', marginTop: '5px', color: 'var(--text-muted)' }, textContent: d.content }),
    ]));
  });
}


/* ─────────────────────────────────────────────────────────────
   SECTION 19 — PROGRESS & CGPA
   ───────────────────────────────────────────────────────────── */

function initChart() {
  if (progressChart) progressChart.destroy();
  const canvas = getEl('progressChart');
  if (!canvas) return;

  progressChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: [],
      datasets: [{
        label: 'SGPA / Marks',
        data: [],
        backgroundColor: 'rgba(0,105,92,0.6)',
        borderColor: 'rgba(0,77,64,1)',
        borderWidth: 1,
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, max: 100 } },
      plugins: { legend: { display: false } },
    },
  });
}

async function addProgress() {
  if (!currentUser) return;
  const sem = getEl('sem-no')?.value ?? '';
  const marks = parseFloat(getEl('sem-marks')?.value ?? '');

  if (!sem || isNaN(marks)) { Toast.show('Please enter semester details.', 'warning'); return; }

  await supa.from('progress').insert({ user_id: currentUser.id, sem, marks });

  const semNo = getEl('sem-no');
  const semMark = getEl('sem-marks');
  if (semNo) semNo.value = '';
  if (semMark) semMark.value = '';

  Toast.show('Semester progress added! 📊');
  loadProgress();
  updateDashboard();
}

async function loadProgress() {
  if (!currentUser) return;
  const { data } = await supa.from('progress')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('sem');

  const tbody = getEl('progress-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (progressChart) {
    progressChart.data.labels = [];
    progressChart.data.datasets[0].data = [];
  }

  let total = 0, count = 0;

  (data ?? []).forEach(d => {
    tbody.appendChild(el('tr', {}, [
      el('td', { textContent: `Semester ${d.sem}` }),
      el('td', { textContent: String(d.marks) }),
      el('td', {}, [
        el('button', {
          className: 'btn-delete',
          textContent: 'Delete',
          'aria-label': `Delete semester ${d.sem} entry`,
          onClick: async () => {
            await supa.from('progress').delete().eq('id', d.id);
            loadProgress();
            updateDashboard();
          },
        }),
      ]),
    ]));

    if (progressChart) {
      progressChart.data.labels.push(`Sem ${d.sem}`);
      progressChart.data.datasets[0].data.push(d.marks);
    }

    total += d.marks;
    count++;
  });

  if (progressChart) progressChart.update();

  const cgpaDisplay = getEl('cgpa-display');
  const currentGpa = count > 0 ? total / count : 0;
  if (cgpaDisplay) cgpaDisplay.textContent = currentGpa.toFixed(2);

  _updateGpaGoal(currentGpa);
}

function saveGpaGoal() {
  const goal = parseFloat(getEl('gpa-goal-input')?.value ?? '');
  if (isNaN(goal)) { Toast.show('Enter a valid GPA goal.', 'warning'); return; }
  localStorage.setItem('sp-gpa-goal', String(goal));
  Toast.show(`GPA goal set to ${goal.toFixed(2)}! 🎯`);
  loadProgress();
}

function _updateGpaGoal(currentGpa) {
  const goal = parseFloat(localStorage.getItem('sp-gpa-goal') ?? '0') || 0;
  const goalDisplay = getEl('gpa-goal-display');
  if (!goalDisplay) return;

  if (goal <= 0) {
    goalDisplay.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">Set a GPA goal above to track your progress!</p>';
    return;
  }

  const pct = Math.min((currentGpa / goal) * 100, 100);
  const diff = (goal - currentGpa).toFixed(2);

  goalDisplay.innerHTML = '';
  goalDisplay.appendChild(el('div', { className: 'gpa-goal-widget' }, [
    el('div', { className: 'gpg-info' }, [
      el('h4', { textContent: `${currentGpa.toFixed(2)} / ${goal.toFixed(2)}` }),
      el('p', { textContent: currentGpa >= goal ? '🎉 You\'ve reached your goal!' : `Need ${diff} more to reach your goal` }),
    ]),
  ]));
  goalDisplay.appendChild(el('div', { className: 'task-progress', style: { marginTop: '8px' } }, [
    el('div', { className: 'task-progress-bar' }, [
      el('div', { className: 'task-progress-fill', style: { width: `${pct}%` } }),
    ]),
  ]));
}


/* ─────────────────────────────────────────────────────────────
   SECTION 20 — PROFILE
   ───────────────────────────────────────────────────────────── */

async function saveProfile() {
  const name = getEl('p-name')?.value.trim() ?? '';
  if (!name) { Toast.show('Please enter at least your name.', 'warning'); return; }

  const payload = {
    user_id: currentUser.id,
    name,
    reg: getEl('p-reg')?.value.trim() ?? '',
    phone: getEl('p-phone')?.value.trim() ?? '',
    adm: getEl('p-adm')?.value.trim() ?? '',
    act: getEl('p-act')?.value.trim() ?? '',
  };

  const { error } = await supa.from('profiles')
    .upsert(payload, { onConflict: 'user_id' });

  if (error) { Toast.show(`Save failed: ${error.message}`, 'error'); return; }

  Toast.show('Profile saved! 👤');
  loadProfile();
}

async function loadProfile() {
  const { data } = await supa.from('profiles')
    .select('*')
    .eq('user_id', currentUser.id)
    .maybeSingle();

  if (!data) return;

  const fields = [
    ['p-name', 'dp-name', data.name],
    ['p-reg', 'dp-reg', data.reg],
    ['p-phone', 'dp-phone', data.phone],
    ['p-adm', 'dp-adm', data.adm],
    ['p-act', 'dp-act', data.act],
  ];

  fields.forEach(([inputId, displayId, value]) => {
    const inp = getEl(inputId); if (inp) inp.value = value ?? '';
    const disp = getEl(displayId); if (disp) disp.textContent = value ?? '';
  });

  const profileDisplay = getEl('profile-display');
  if (profileDisplay) profileDisplay.style.display = 'block';
}


/* ─────────────────────────────────────────────────────────────
   SECTION 21 — POMODORO TIMER
   ───────────────────────────────────────────────────────────── */

let _pomoInterval = null;
let _pomoSeconds = CONFIG.POMO_MODES.study;
let _pomoRunning = false;
let _pomoMode = 'study';
let _pomoSessions = 0;

const POMO_LABELS = Object.freeze({ study: 'STUDY TIME', break: 'SHORT BREAK', longbreak: 'LONG BREAK' });

function setPomoMode(mode) {
  _pomoMode = mode;
  resetPomodoro();
  const label = getEl('pomo-label');
  if (label) label.textContent = POMO_LABELS[mode] ?? 'STUDY TIME';
}

function startPomodoro() {
  if (_pomoRunning) return;
  _pomoRunning = true;

  _pomoInterval = setInterval(() => {
    if (_pomoSeconds <= 0) {
      clearInterval(_pomoInterval);
      _pomoRunning = false;
      _pomoSessions++;

      const sessionsEl = getEl('pomo-sessions');
      if (sessionsEl) sessionsEl.textContent = `Sessions: ${_pomoSessions}`;

      if (_pomoMode === 'study') {
        const subject = getEl('pomo-subject')?.value || 'General';
        logStudyTime(subject, 25);

        if (_pomoSessions % 4 === 0) {
          Toast.show('🎉 4 sessions done! Take a long 15-min break.', 'success');
          setPomoMode('longbreak');
        } else {
          Toast.show('⏰ Study session complete! Take a 5-min break.', 'success');
          setPomoMode('break');
        }
      } else {
        Toast.show('☕ Break over! Back to studying.', 'info');
        setPomoMode('study');
      }
      return;
    }

    _pomoSeconds--;
    _updatePomoDisplay();
  }, 1000);
}

function pausePomodoro() {
  clearInterval(_pomoInterval);
  _pomoRunning = false;
}

function resetPomodoro() {
  clearInterval(_pomoInterval);
  _pomoRunning = false;
  _pomoSeconds = CONFIG.POMO_MODES[_pomoMode] ?? CONFIG.POMO_MODES.study;
  _updatePomoDisplay();
}

// Cached DOM elements for Pomodoro — avoids getElementById every second
let _pomoTimeEl = null;
let _pomoRingEl = null;

function _updatePomoDisplay() {
  const m = Math.floor(_pomoSeconds / 60);
  const s = _pomoSeconds % 60;
  const timeStr = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

  if (!_pomoTimeEl) _pomoTimeEl = getEl('pomo-time');
  if (_pomoTimeEl) _pomoTimeEl.textContent = timeStr;

  const total = CONFIG.POMO_MODES[_pomoMode] ?? CONFIG.POMO_MODES.study;
  const offset = 2 * Math.PI * 100 * (_pomoSeconds / total);
  if (!_pomoRingEl) _pomoRingEl = getEl('pomo-ring');
  if (_pomoRingEl) _pomoRingEl.style.strokeDashoffset = offset;

  // Update document title when timer is running
  if (_pomoRunning) {
    document.title = `(${timeStr}) StudyPlanner`;
  } else {
    document.title = 'StudyPlanner – Smart Study Companion';
  }
}


/* ─────────────────────────────────────────────────────────────
   SECTION 22 — TASK TRACKER
   ───────────────────────────────────────────────────────────── */

async function addTask() {
  if (!currentUser) return;
  const input = getEl('task-input');
  const text = input?.value.trim() ?? '';
  if (!text) return;

  await supa.from('tasks').insert({ user_id: currentUser.id, text, done: false });
  if (input) input.value = '';

  Toast.show('Task added! ✅');
  loadTasks();
}

async function loadTasks() {
  if (!currentUser) return;
  const { data } = await supa.from('tasks')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('created_at');

  const container = getEl('tasks-container');
  if (!container) return;
  container.innerHTML = '';

  let total = 0, done = 0;

  (data ?? []).forEach(d => {
    total++;
    if (d.done) done++;

    const checkbox = el('input', { type: 'checkbox', 'aria-label': d.text });
    checkbox.checked = d.done;
    checkbox.addEventListener('change', async function () {
      await supa.from('tasks').update({ done: this.checked }).eq('id', d.id);
      loadTasks();
      updateDashboard();
    });

    container.appendChild(el('div', {
      className: `task-item${d.done ? ' done' : ''}`,
    }, [
      checkbox,
      el('span', { textContent: d.text }),
      el('button', {
        className: 'btn-delete',
        textContent: '✕',
        'aria-label': `Delete task: ${d.text}`,
        onClick: async () => {
          await supa.from('tasks').delete().eq('id', d.id);
          loadTasks();
          updateDashboard();
        },
      }),
    ]));
  });

  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const fill = getEl('task-fill');
  const text = getEl('task-progress-text');
  if (fill) fill.style.width = `${pct}%`;
  if (text) text.textContent = `${done} / ${total} completed`;

  if (tasksInitialized && total > 0 && done === total) {
    triggerConfetti();
    Toast.show('🎉 All tasks completed! Amazing work!', 'success');
  }

  tasksInitialized = true;
  // Dashboard update removed here — handled by callers & initApp to avoid duplicate fetches
}


/* ─────────────────────────────────────────────────────────────
   SECTION 23 — FLASHCARDS
   ───────────────────────────────────────────────────────────── */

async function addFlashcard() {
  if (!currentUser) return;
  const front = getEl('fc-front')?.value.trim() ?? '';
  const back = getEl('fc-back')?.value.trim() ?? '';
  const subject = getEl('fc-subject')?.value.trim() ?? '';

  if (!front || !back) {
    Toast.show('Please fill in both sides of the flashcard.', 'warning');
    return;
  }

  await supa.from('flashcards').insert({ user_id: currentUser.id, front, back, subject });

  ['fc-front', 'fc-back', 'fc-subject'].forEach(id => {
    const e = getEl(id); if (e) e.value = '';
  });

  Toast.show('Flashcard created! 🃏');
  loadFlashcards();
  updateDashboard();
}

async function loadFlashcards() {
  if (!currentUser) return;
  const { data } = await supa.from('flashcards')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false });

  const deck = getEl('flashcard-deck');
  if (!deck) return;
  deck.innerHTML = '';

  (data ?? []).forEach(d => {
    deck.appendChild(el('div', {
      className: 'flashcard',
      role: 'button',
      tabIndex: '0',
      'aria-label': `Flashcard: ${d.front}. Press Enter or Space to flip.`,
      onClick(e) {
        if (e.target.classList.contains('btn-delete') || e.target.closest('.btn-delete')) return;
        this.classList.toggle('flipped');
        this.setAttribute('aria-label',
          this.classList.contains('flipped')
            ? `Flashcard answer: ${d.back}. Press Enter or Space to flip back.`
            : `Flashcard: ${d.front}. Press Enter or Space to flip.`);
      },
      onKeydown(e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.click(); }
      },
    }, [
      el('div', { className: 'flashcard-inner' }, [
        el('div', { className: 'flashcard-front' }, [
          el('span', { textContent: d.front }),
          el('small', { textContent: d.subject || 'General' }),
        ]),
        el('div', { className: 'flashcard-back' }, [
          el('span', { textContent: d.back }),
          el('button', {
            className: 'btn-delete fc-delete',
            textContent: '🗑️',
            'aria-label': `Delete flashcard: ${d.front}`,
            onClick: async e => {
              e.stopPropagation();
              await supa.from('flashcards').delete().eq('id', d.id);
              loadFlashcards();
              updateDashboard();
            },
          }),
        ]),
      ]),
    ]));
  });
}


/* ─────────────────────────────────────────────────────────────
   SECTION 24 — ATTENDANCE
   Students: read-only calendar view
   Admin:    write access via attendance_records table
   Schema:   attendance_records (id, user_id, subject, date, present)
             UNIQUE constraint on (user_id, subject, date)
   ───────────────────────────────────────────────────────────── */

/** Calendar state — shared across subject changes */
let _attCalYear = new Date().getFullYear();
let _attCalMonth = new Date().getMonth(); // 0-indexed

/**
 * Called by initApp().
 * Populates the subject dropdown from the student's existing records.
 */
async function loadAttendance() {
  if (!currentUser) return;

  const { data } = await supa
    .from('attendance_records')
    .select('subject')
    .eq('user_id', currentUser.id);

  const subjects = [...new Set((data ?? []).map(r => r.subject))].sort();
  const sel = getEl('att-subject-filter');
  if (!sel) return;

  const prev = sel.value;
  sel.innerHTML = '<option value="">— Select Subject —</option>';
  subjects.forEach(s => sel.appendChild(el('option', { value: s, textContent: s })));
  if (prev && subjects.includes(prev)) sel.value = prev;

  const grid = getEl('attendance-grid');
  if (sel.value) {
    renderAttendanceCalendar(sel.value);
  } else if (grid) {
    grid.innerHTML = '<p class="att-empty-hint">Select a subject above to view your attendance calendar.</p>';
  }
}

/**
 * Render a monthly calendar for a given subject.
 * Present days are marked with "X" per requirements.
 * @param {string} subject
 */
async function renderAttendanceCalendar(subject) {
  const grid = getEl('attendance-grid');
  if (!grid || !currentUser || !subject) return;

  grid.innerHTML = '<p class="att-loading">Loading calendar…</p>';

  const { data } = await supa
    .from('attendance_records')
    .select('date, present')
    .eq('user_id', currentUser.id)
    .eq('subject', subject);

  // date string → boolean
  const records = {};
  (data ?? []).forEach(r => { records[r.date] = r.present; });

  const allDates = Object.keys(records);
  const totalDays = allDates.length;
  const presentDays = allDates.filter(d => records[d]).length;
  const absentDays = totalDays - presentDays;
  const pct = totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 0;
  const pctColor = pct < 75 ? '#c62828' : pct < 85 ? '#e65100' : '#2e7d32';
  const barClass = pct < 75 ? 'danger' : pct < 85 ? 'warn' : 'good';

  grid.innerHTML = '';

  // ── Stats row ──────────────────────────────────────────────
  grid.appendChild(el('div', { className: 'att-stats-row' }, [
    el('div', { className: 'att-stat-chip' }, [
      el('span', { className: 'asc-val', style: { color: pctColor }, textContent: `${pct}%` }),
      el('span', { className: 'asc-lbl', textContent: 'Attendance' }),
    ]),
    el('div', { className: 'att-stat-chip' }, [
      el('span', { className: 'asc-val', style: { color: '#2e7d32' }, textContent: presentDays }),
      el('span', { className: 'asc-lbl', textContent: 'Present' }),
    ]),
    el('div', { className: 'att-stat-chip' }, [
      el('span', { className: 'asc-val', style: { color: '#c62828' }, textContent: absentDays }),
      el('span', { className: 'asc-lbl', textContent: 'Absent' }),
    ]),
    el('div', { className: 'att-stat-chip' }, [
      el('span', { className: 'asc-val', textContent: totalDays }),
      el('span', { className: 'asc-lbl', textContent: 'Total' }),
    ]),
  ]));

  // ── Percentage bar ─────────────────────────────────────────
  grid.appendChild(el('div', {
    className: 'att-bar-wrap',
    role: 'progressbar',
    'aria-valuenow': pct, 'aria-valuemin': '0', 'aria-valuemax': '100',
    style: { margin: '0 0 18px' },
  }, [
    el('div', { className: `att-bar-fill ${barClass}`, style: { width: `${pct}%` } }),
  ]));

  // Low-attendance warning
  if (totalDays > 0 && pct < 75) {
    grid.appendChild(el('div', { className: 'att-warning' }, [
      el('span', { textContent: '⚠️ Attendance below 75% — you may be at risk of shortage.' }),
    ]));
  }

  // ── Month navigator ────────────────────────────────────────
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  grid.appendChild(el('div', { className: 'att-cal-nav' }, [
    el('button', {
      className: 'att-nav-btn', type: 'button', textContent: '‹',
      'aria-label': 'Previous month',
      onClick: () => {
        _attCalMonth--;
        if (_attCalMonth < 0) { _attCalMonth = 11; _attCalYear--; }
        renderAttendanceCalendar(subject);
      },
    }),
    el('span', {
      className: 'att-cal-month-label',
      textContent: `${MONTHS[_attCalMonth]} ${_attCalYear}`,
    }),
    el('button', {
      className: 'att-nav-btn', type: 'button', textContent: '›',
      'aria-label': 'Next month',
      onClick: () => {
        _attCalMonth++;
        if (_attCalMonth > 11) { _attCalMonth = 0; _attCalYear++; }
        renderAttendanceCalendar(subject);
      },
    }),
  ]));

  // ── Calendar grid ──────────────────────────────────────────
  const calWrap = el('div', {
    className: 'att-cal-grid',
    role: 'grid',
    'aria-label': `Attendance calendar for ${MONTHS[_attCalMonth]} ${_attCalYear}`,
  });

  // Day-of-week headers
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(d =>
    calWrap.appendChild(el('div', { className: 'att-cal-hdr', textContent: d, role: 'columnheader' }))
  );

  const firstDOW = new Date(_attCalYear, _attCalMonth, 1).getDay();
  const daysInMon = new Date(_attCalYear, _attCalMonth + 1, 0).getDate();
  const todayStr = new Date().toISOString().split('T')[0];

  // Leading empty cells
  for (let i = 0; i < firstDOW; i++) {
    calWrap.appendChild(el('div', { className: 'att-cal-cell empty', 'aria-hidden': 'true' }));
  }

  // Day cells
  for (let d = 1; d <= daysInMon; d++) {
    const mm = String(_attCalMonth + 1).padStart(2, '0');
    const dd = String(d).padStart(2, '0');
    const dateStr = `${_attCalYear}-${mm}-${dd}`;
    const status = records[dateStr]; // true | false | undefined

    let cls = 'att-cal-cell';
    if (dateStr === todayStr) cls += ' today';
    if (status === true) cls += ' present';
    else if (status === false) cls += ' absent';

    const ariaLabel = status === true ? `${dateStr}: Present`
      : status === false ? `${dateStr}: Absent`
        : `${dateStr}`;

    calWrap.appendChild(el('div', { className: cls, role: 'gridcell', 'aria-label': ariaLabel }, [
      el('span', { className: 'att-day-num', textContent: d }),
      // "X" marks present days per product requirement
      (status === true) ? el('span', { className: 'att-day-mark att-present-x', textContent: 'X', 'aria-hidden': 'true' }) : null,
      (status === false) ? el('span', { className: 'att-day-mark att-absent-dash', textContent: '—', 'aria-hidden': 'true' }) : null,
    ]));
  }

  grid.appendChild(calWrap);

  // ── Legend ─────────────────────────────────────────────────
  grid.appendChild(el('div', { className: 'att-legend' }, [
    el('span', { className: 'att-leg-item present' }, [
      el('span', { className: 'att-leg-swatch' }),
      document.createTextNode(' Present (X)'),
    ]),
    el('span', { className: 'att-leg-item absent' }, [
      el('span', { className: 'att-leg-swatch' }),
      document.createTextNode(' Absent'),
    ]),
    el('span', { className: 'att-leg-item today' }, [
      el('span', { className: 'att-leg-swatch' }),
      document.createTextNode(' Today'),
    ]),
  ]));
}


/* ─── ADMIN: ATTENDANCE MANAGEMENT ──────────────────────────
   Admin writes to attendance_records.
   Table: attendance_records (id, user_id, subject, date, present)
   Unique: (user_id, subject, date)
   ─────────────────────────────────────────────────────────── */

async function adminLoadAttendancePanel() {
  const { data: profiles } = await supa
    .from('profiles')
    .select('user_id, name, reg')
    .order('name');

  const sel = getEl('admin-att-student');
  if (!sel) return;

  const prev = sel.value;
  sel.innerHTML = '<option value="">— Select Student —</option>';
  (profiles ?? []).forEach(p => {
    sel.appendChild(el('option', {
      value: p.user_id,
      textContent: `${p.name ?? 'Unknown'}${p.reg ? ' (' + p.reg + ')' : ''}`,
    }));
  });
  if (prev) sel.value = prev;

  const dateEl = getEl('admin-att-date');
  if (dateEl && !dateEl.value) dateEl.value = new Date().toISOString().split('T')[0];

  adminLoadAttendanceRecords();
}

async function adminMarkAttendance() {
  const userId = getEl('admin-att-student')?.value ?? '';
  const subject = getEl('admin-att-subject')?.value.trim() ?? '';
  const date = getEl('admin-att-date')?.value ?? '';
  const present = getEl('admin-att-present')?.value === 'true';

  if (!userId || !subject || !date) {
    Toast.show('Please select a student, enter a subject, and choose a date.', 'warning');
    return;
  }

  const { error } = await supa.from('attendance_records').upsert(
    { user_id: userId, subject, date, present },
    { onConflict: 'user_id,subject,date' }
  );

  if (error) { Toast.show(`Error: ${error.message}`, 'error'); return; }

  Toast.show(`Saved: ${present ? '✓ Present' : '✗ Absent'} for ${date}`, 'success');
  adminLoadAttendanceRecords();
}

async function adminLoadAttendanceRecords() {
  const userId = getEl('admin-att-student')?.value ?? '';
  const subject = getEl('admin-att-subject')?.value.trim() ?? '';
  const cntEl = getEl('admin-att-record-count');
  const cont = getEl('admin-att-records');
  if (!cont) return;

  if (!userId) {
    cont.innerHTML = '<p class="att-empty-hint">Select a student above to view their records.</p>';
    return;
  }

  cont.innerHTML = '<p class="att-loading">Loading…</p>';

  let q = supa.from('attendance_records')
    .select('*')
    .eq('user_id', userId)
    .order('date', { ascending: false })
    .limit(60);

  if (subject) q = q.eq('subject', subject);
  const { data } = await q;

  cont.innerHTML = '';
  if (cntEl) cntEl.textContent = `(${data?.length ?? 0})`;

  if (!data?.length) {
    cont.innerHTML = '<p class="att-empty-hint">No records found for this selection.</p>';
    return;
  }

  const wrap = el('div', { style: { overflowX: 'auto' } });
  const table = el('table', { 'aria-label': 'Attendance records' });
  table.appendChild(el('thead', {}, [el('tr', {}, [
    el('th', { scope: 'col', textContent: 'Date' }),
    el('th', { scope: 'col', textContent: 'Subject' }),
    el('th', { scope: 'col', textContent: 'Status' }),
    el('th', { scope: 'col', textContent: 'Action' }),
  ])]));
  const tbody = el('tbody');
  data.forEach(r => {
    tbody.appendChild(el('tr', {}, [
      el('td', { textContent: r.date }),
      el('td', { textContent: r.subject }),
      el('td', {}, [
        el('span', {
          className: r.present ? 'status-safe' : 'status-danger',
          textContent: r.present ? '✓ Present' : '✗ Absent',
        }),
      ]),
      el('td', {}, [
        el('button', {
          className: 'btn-delete', type: 'button', textContent: 'Delete',
          'aria-label': `Delete ${r.date} record`,
          onClick: async () => {
            if (!confirm(`Delete record: ${r.date} – ${r.subject}?`)) return;
            await supa.from('attendance_records').delete().eq('id', r.id);
            Toast.show('Record deleted.', 'warning');
            adminLoadAttendanceRecords();
          },
        }),
      ]),
    ]));
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  cont.appendChild(wrap);
}


/* ─────────────────────────────────────────────────────────────
   SECTION 25 — ADMIN: STUDENT REPORTS
   (Export moved here from student side — admin-only)
   ───────────────────────────────────────────────────────────── */

/**
 * Load all students with their CGPA and attendance summaries.
 * Renders cards in #admin-reports-container.
 */
async function adminLoadStudentReports() {
  const container = getEl('admin-reports-container');
  if (!container) return;
  container.innerHTML = '<p style="color:var(--text-muted);font-size:0.88rem;">Loading student data…</p>';

  // Fetch all profiles, progress, attendance in parallel
  const [profilesRes, progressRes, attendanceRes, tasksRes] = await Promise.all([
    supa.from('profiles').select('*'),
    supa.from('progress').select('user_id, marks'),
    supa.from('attendance_records').select('user_id, present'),
    supa.from('tasks').select('user_id, done'),
  ]);

  const profiles = profilesRes.data ?? [];
  const progress = progressRes.data ?? [];
  const attendance = attendanceRes.data ?? [];
  const tasks = tasksRes.data ?? [];

  container.innerHTML = '';

  if (!profiles.length) {
    container.appendChild(el('p', {
      style: { color: 'var(--text-muted)', fontSize: '0.88rem', textAlign: 'center', padding: '20px' },
      textContent: 'No registered students yet.',
    }));
    return;
  }

  profiles.forEach(p => {
    // Calculate CGPA for this student
    const studentProgress = progress.filter(r => r.user_id === p.user_id);
    const cgpa = studentProgress.length
      ? (studentProgress.reduce((s, r) => s + r.marks, 0) / studentProgress.length).toFixed(2)
      : '—';

    // Calculate overall attendance % from per-day records
    const studentAtt = attendance.filter(r => r.user_id === p.user_id);
    const totalClasses = studentAtt.length;
    const presentClasses = studentAtt.filter(r => r.present).length;
    const attPct = totalClasses > 0 ? Math.round((presentClasses / totalClasses) * 100) : null;

    // Task completion
    const studentTasks = tasks.filter(r => r.user_id === p.user_id);
    const doneTasks = studentTasks.filter(r => r.done).length;

    const attColor = attPct === null ? 'var(--text-muted)' : attPct < 75 ? '#c62828' : attPct < 85 ? '#f57f17' : '#2e7d32';
    const attText = attPct === null ? 'No data' : `${attPct}%`;

    container.appendChild(el('div', { className: 'admin-report-card' }, [

      // Avatar + name row
      el('div', { className: 'arc-header' }, [
        el('div', { className: 'admin-user-avatar', textContent: (p.name ?? 'U').charAt(0).toUpperCase() }),
        el('div', { className: 'arc-identity' }, [
          el('strong', { textContent: p.name ?? 'Unknown Student' }),
          el('span', { textContent: p.reg ? `Reg: ${p.reg}` : 'No reg number' }),
          el('span', { textContent: p.phone ? `📞 ${p.phone}` : '' }),
        ]),
      ]),

      // Stats row
      el('div', { className: 'arc-stats' }, [
        el('div', { className: 'arc-stat' }, [
          el('span', { className: 'arc-stat-val', textContent: cgpa }),
          el('span', { className: 'arc-stat-label', textContent: 'CGPA' }),
        ]),
        el('div', { className: 'arc-stat' }, [
          el('span', { className: 'arc-stat-val', style: { color: attColor }, textContent: attText }),
          el('span', { className: 'arc-stat-label', textContent: 'Attendance' }),
        ]),
        el('div', { className: 'arc-stat' }, [
          el('span', { className: 'arc-stat-val', textContent: studentTasks.length > 0 ? `${doneTasks}/${studentTasks.length}` : '—' }),
          el('span', { className: 'arc-stat-label', textContent: 'Tasks Done' }),
        ]),
        el('div', { className: 'arc-stat' }, [
          el('span', { className: 'arc-stat-val', textContent: studentProgress.length > 0 ? `Sem ${studentProgress.length}` : '—' }),
          el('span', { className: 'arc-stat-label', textContent: 'Semesters' }),
        ]),
      ]),

      // Admission info
      p.adm ? el('div', { style: { fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '4px' }, textContent: `Adm: ${p.adm}` }) : null,
    ]));
  });
}

/** Live client-side search across rendered report cards. Debounced. */
const filterReportCards = _debounce(() => {
  const query = getEl('report-search')?.value.toLowerCase().trim() ?? '';
  const cards = getEl('admin-reports-container')?.querySelectorAll('.admin-report-card') ?? [];
  cards.forEach(card => {
    card.style.display = card.textContent.toLowerCase().includes(query) ? '' : 'none';
  });
});

/** Export all students' profiles as CSV — admin only */
async function adminExportStudentsCSV() {
  const { data } = await supa.from('profiles').select('*');
  const csv = 'Name,Reg No,Phone,Admission No,Activities\n' +
    (data ?? []).map(d =>
      `"${d.name ?? ''}","${d.reg ?? ''}","${d.phone ?? ''}","${d.adm ?? ''}","${d.act ?? ''}"`
    ).join('\n');
  _downloadCSV(csv, 'all_students.csv');
}

/** Export all students' CGPA progress as CSV — admin only */
async function adminExportProgressCSV() {
  const [profilesRes, progressRes] = await Promise.all([
    supa.from('profiles').select('user_id, name, reg'),
    supa.from('progress').select('user_id, sem, marks'),
  ]);
  const profiles = profilesRes.data ?? [];
  const progress = progressRes.data ?? [];
  const csv = 'Student Name,Reg No,Semester,Score\n' +
    progress.map(r => {
      const p = profiles.find(p => p.user_id === r.user_id);
      return `"${p?.name ?? 'Unknown'}","${p?.reg ?? ''}",${r.sem},${r.marks}`;
    }).join('\n');
  _downloadCSV(csv, 'all_progress.csv');
}

/** Export all students' attendance as CSV — admin only */
async function adminExportAttendanceCSV() {
  const [profilesRes, attRes] = await Promise.all([
    supa.from('profiles').select('user_id, name, reg'),
    supa.from('attendance_records').select('user_id, subject, present'),
  ]);
  const profiles = profilesRes.data ?? [];
  const records = attRes.data ?? [];
  // Aggregate per (user, subject)
  const agg = {};
  records.forEach(r => {
    const k = `${r.user_id}||${r.subject}`;
    if (!agg[k]) agg[k] = { user_id: r.user_id, subject: r.subject, present: 0, total: 0 };
    agg[k].total++;
    if (r.present) agg[k].present++;
  });
  const csv = 'Student Name,Reg No,Subject,Present,Total,Percentage\n' +
    Object.values(agg).map(r => {
      const p = profiles.find(p => p.user_id === r.user_id);
      const pct = r.total > 0 ? Math.round((r.present / r.total) * 100) : 0;
      return `"${p?.name ?? 'Unknown'}","${p?.reg ?? ''}","${r.subject}",${r.present},${r.total},${pct}%`;
    }).join('\n');
  _downloadCSV(csv, 'all_attendance.csv');
}

function _downloadCSV(csv, filename) {
  const a = document.createElement('a');
  const href = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' }));
  a.href = href;
  a.download = filename;
  a.click();
  // Delay revocation — download may not have started yet on some browsers
  setTimeout(() => URL.revokeObjectURL(href), 1500);
  Toast.show(`Exported ${filename} 📥`, 'success');
}


/* ─────────────────────────────────────────────────────────────
   SECTION 25B — STUDY REQUESTS
   Students submit requests (subject, exam date, difficulty).
   Admin reviews and responds with a study timetable.
   Table: study_requests (id, user_id, subject, exam_date, difficulty,
          status, admin_timetable, created_at)
   ───────────────────────────────────────────────────────────── */

/** STUDENT: Generate a study timetable automatically */
async function submitStudyRequest() {
  if (!currentUser) return;
  const subject = getEl('sr-subject')?.value.trim() ?? '';
  const examDate = getEl('sr-exam-date')?.value ?? '';
  const difficulty = getEl('sr-difficulty')?.value ?? 'medium';

  if (!subject || !examDate) {
    Toast.show('Please enter the subject and exam date.', 'warning');
    return;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exam = new Date(examDate);
  const diffTime = exam - today;
  const daysLeft = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  const { error } = await supa.from('study_requests').insert({
    user_id: currentUser.id,
    subject,
    exam_date: examDate,
    difficulty
  });

  if (error) { Toast.show(`Error: ${error.message}`, 'error'); return; }

  ['sr-subject', 'sr-exam-date'].forEach(id => {
    const e = getEl(id); if (e) e.value = '';
  });

  Toast.show('Request submitted! Admin will review.', 'success');
  loadStudyRequests();
}

/** STUDENT: Load and render this student's study requests */
async function loadStudyRequests() {
  if (!currentUser) return;
  const container = getEl('student-requests-container');
  if (!container) return;

  container.innerHTML = '<p style="color:var(--text-muted);font-size:0.88rem;">Loading…</p>';

  const { data, error } = await supa.from('study_requests')
    .select('*, study_timetables(timetable_data)')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false });

  container.innerHTML = '';

  if (error || !data?.length) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:0.88rem;text-align:center;padding:20px;">No study requests yet. Submit one above!</p>';
    return;
  }

  data.forEach(req => {
    const isPending = req.status === 'pending';
    const diffBadge = _difficultyBadge(req.difficulty);
    const statusBadge = el('span', {
      className: isPending ? 'sr-badge sr-pending' : 'sr-badge sr-responded',
      textContent: isPending ? '⏳ Pending' : '✅ Approved',
    });

    const daysLeft = Math.ceil((new Date(req.exam_date) - new Date()) / 86_400_000);
    const daysText = daysLeft > 0 ? `${daysLeft} day${daysLeft !== 1 ? 's' : ''} left`
      : daysLeft === 0 ? 'Exam today!' : 'Exam passed';

    const card = el('div', { className: 'sr-card' }, [
      el('div', { className: 'sr-card-header' }, [
        el('strong', { textContent: req.subject }),
        statusBadge,
      ]),
      el('div', { className: 'sr-card-meta' }, [
        el('span', { textContent: `📅 ${req.exam_date}` }),
        el('span', { textContent: `(${daysText})`, style: { color: daysLeft <= 3 ? '#c62828' : 'var(--text-muted)' } }),
        diffBadge,
      ]),
    ]);

    // Show timetable response if approved
    const timetableData = req.study_timetables?.[0]?.timetable_data;
    const ttContent = typeof timetableData === 'string' ? timetableData : timetableData?.content;

    if (!isPending && ttContent) {
      card.appendChild(el('div', { className: 'sr-timetable-response' }, [
        el('div', { className: 'sr-tt-label', textContent: '📋 Approved Timetable:' }),
        el('pre', { className: 'sr-tt-content', textContent: ttContent }),
      ]));
    }

    // Delete button
    card.appendChild(el('button', {
      className: 'btn-delete',
      style: { position: 'absolute', top: '10px', right: '10px' },
      textContent: '✕',
      'aria-label': `Delete request for ${req.subject}`,
      onClick: async () => {
        await supa.from('study_requests').delete().eq('id', req.id);
        Toast.show('Request deleted.', 'warning');
        loadStudyRequests();
      },
    }));

    container.appendChild(card);
  });
}

/** ADMIN: Load all student study requests */
async function adminLoadStudyRequests() {
  const container = getEl('admin-requests-container');
  if (!container) return;

  container.innerHTML = '<p style="color:var(--text-muted);font-size:0.88rem;">Loading requests…</p>';

  const filter = getEl('admin-request-filter')?.value ?? 'all';

  // Fetch requests and profiles in parallel
  const [reqRes, profRes] = await Promise.all([
    supa.from('study_requests').select('*, study_timetables(timetable_data)').order('created_at', { ascending: false }),
    supa.from('profiles').select('user_id, name, reg'),
  ]);

  const requests = reqRes.data ?? [];
  const profiles = profRes.data ?? [];
  const profileMap = {};
  profiles.forEach(p => { profileMap[p.user_id] = p; });

  // Update pending count on admin dashboard
  const pendingCount = requests.filter(r => r.status === 'pending').length;
  const countEl = getEl('admin-request-count');
  if (countEl) countEl.textContent = pendingCount > 0 ? `${pendingCount} pending` : '0';

  // Filter
  const filtered = filter === 'all' ? requests
    : requests.filter(r => r.status === filter);

  container.innerHTML = '';

  if (!filtered.length) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:0.88rem;text-align:center;padding:20px;">No requests found.</p>';
    return;
  }

  filtered.forEach(req => {
    const profile = profileMap[req.user_id];
    const studentName = profile?.name ?? 'Unknown Student';
    const studentReg = profile?.reg ? ` (${profile.reg})` : '';
    const isPending = req.status === 'pending';
    const diffBadge = _difficultyBadge(req.difficulty);
    const daysLeft = Math.ceil((new Date(req.exam_date) - new Date()) / 86_400_000);
    const daysText = daysLeft > 0 ? `${daysLeft} day${daysLeft !== 1 ? 's' : ''} left`
      : daysLeft === 0 ? 'Exam today!' : 'Exam passed';

    const card = el('div', { className: `sr-card sr-admin-card ${isPending ? 'sr-card-pending' : ''}` }, [
      el('div', { className: 'sr-card-header' }, [
        el('div', {}, [
          el('strong', { textContent: req.subject }),
          el('span', {
            style: { marginLeft: '8px', fontSize: '0.8rem', color: 'var(--text-muted)' },
            textContent: `by ${studentName}${studentReg}`,
          }),
        ]),
        el('span', {
          className: isPending ? 'sr-badge sr-pending' : 'sr-badge sr-responded',
          textContent: isPending ? '⏳ Pending' : '✅ Approved',
        }),
      ]),
      el('div', { className: 'sr-card-meta' }, [
        el('span', { textContent: `📅 Exam: ${req.exam_date}` }),
        el('span', { textContent: `(${daysText})`, style: { color: daysLeft <= 3 ? '#c62828' : 'var(--text-muted)' } }),
        diffBadge,
      ]),
    ]);

    if (isPending) {
      // Show a textarea for admin to type the timetable response
      const textareaId = `admin-tt-${req.id}`;
      card.appendChild(el('div', { className: 'sr-admin-reply' }, [
        el('label', { htmlFor: textareaId, textContent: '📋 Provide Study Timetable:', style: { fontWeight: '600', fontSize: '0.88rem' } }),
        el('textarea', {
          id: textareaId,
          placeholder: 'e.g.\nDay 1: Revise Chapter 1-3 (2 hrs)\nDay 2: Practice problems Ch 4-5 (3 hrs)\nDay 3: Revision + mock test…',
          rows: '5',
          style: { width: '100%', marginTop: '8px', padding: '10px', borderRadius: '10px', border: '1.5px solid var(--border-input)', fontFamily: 'inherit', fontSize: '0.88rem', resize: 'vertical', background: 'var(--bg-gray)', color: 'var(--text-dark)' },
        }),
        el('button', {
          className: 'btn-action',
          style: { marginTop: '10px' },
          textContent: '✅ Send Timetable',
          type: 'button',
          onClick: async () => {
            const timetable = getEl(textareaId)?.value.trim() ?? '';
            if (!timetable) {
              Toast.show('Please write a study timetable before sending.', 'warning');
              return;
            }
            await adminRespondToRequest(req, timetable);
          },
        }),
      ]));
    } else {
      // Show the already-sent timetable
      const timetableData = req.study_timetables?.[0]?.timetable_data;
      const ttContent = typeof timetableData === 'string' ? timetableData : timetableData?.content;
      if (ttContent) {
        card.appendChild(el('div', { className: 'sr-timetable-response' }, [
          el('div', { className: 'sr-tt-label', textContent: '📋 Timetable Sent:' }),
          el('pre', { className: 'sr-tt-content', textContent: ttContent }),
        ]));
      }
    }

    container.appendChild(card);
  });
}

/** ADMIN: Respond to a study request with a timetable */
async function adminRespondToRequest(req, timetable) {
  // First insert the timetable
  const { error: ttError } = await supa.from('study_timetables').insert({
    request_id: req.id,
    user_id: req.user_id,
    timetable_data: { content: timetable }
  });

  if (ttError) { Toast.show(`Error: ${ttError.message}`, 'error'); return; }

  // Then update the request status
  const { error: reqError } = await supa.from('study_requests')
    .update({ status: 'approved' })
    .eq('id', req.id);

  if (reqError) { Toast.show(`Error: ${reqError.message}`, 'error'); return; }

  Toast.show('✅ Timetable sent to student!', 'success');
  adminLoadStudyRequests();
}

/** Helper: create a difficulty badge element */
function _difficultyBadge(difficulty) {
  const colors = { easy: '#2e7d32', medium: '#e65100', hard: '#c62828' };
  const labels = { easy: '🟢 Easy', medium: '🟠 Medium', hard: '🔴 Hard' };
  return el('span', {
    className: 'sr-diff-badge',
    textContent: labels[difficulty] ?? difficulty,
    style: { color: colors[difficulty] ?? 'var(--text-muted)' },
  });
}


/* ─────────────────────────────────────────────────────────────
   SECTION 26 — SETTINGS (theme only — API key is in CONFIG)
   ───────────────────────────────────────────────────────────── */

function saveGeminiKey() { } // Deprecated — key lives in CONFIG.GEMINI_KEY


/* ─────────────────────────────────────────────────────────────
   SECTION 27 — AI CHATBOT (Gemini)
   ───────────────────────────────────────────────────────────── */

function toggleChatbot() {
  const win = getEl('chatbot-window');
  if (!win) return;

  const isOpen = win.classList.toggle('open');
  const fab = getEl('chatbot-fab');
  if (fab) fab.style.display = isOpen ? 'none' : 'flex';

  if (isOpen) {
    _initChatbot();
    // Move focus to input if chat area is visible
    setTimeout(() => getEl('chat-input')?.focus(), 300);
  }
}

function closeChatbot() {
  getEl('chatbot-window')?.classList.remove('open');
  const fab = getEl('chatbot-fab');
  if (fab) fab.style.display = 'flex';
}

function _initChatbot() {
  // Key is shared via CONFIG.GEMINI_KEY — no per-user setup needed
  const setup = getEl('chatbot-setup');
  const chatArea = getEl('chatbot-chat-area');
  if (setup) setup.style.display = 'none';
  if (chatArea) chatArea.style.display = 'flex';
}

function saveChatbotKey() { } // Deprecated — key is set in CONFIG.GEMINI_KEY

async function sendChatMessage() {
  const input = getEl('chat-input');
  const msg = input?.value.trim() ?? '';
  if (!msg) return;

  if (input) input.value = '';
  _addChatBubble(msg, 'user');

  // Show typing indicator
  const typingEl = el('div', { className: 'chat-typing', id: 'chat-typing' }, [
    el('div', { className: 'dot' }),
    el('div', { className: 'dot' }),
    el('div', { className: 'dot' }),
  ]);
  getEl('chatbot-messages')?.appendChild(typingEl);
  _scrollChatToBottom();

  try {
    // Refresh the session to ensure we have a valid, non-expired token
    const { data: refreshData, error: refreshErr } = await supa.auth.refreshSession();
    let token;

    if (refreshErr || !refreshData?.session) {
      // Fallback: try getSession (may still be valid)
      const { data: sessionData } = await supa.auth.getSession();
      token = sessionData?.session?.access_token;
    } else {
      token = refreshData.session.access_token;
    }

    if (!token) {
      getEl('chat-typing')?.remove();
      _addChatBubble('⚠️ Session expired. Please log out and log back in.', 'bot');
      return;
    }

    // Call our secure Supabase Edge Function — Gemini key never touches the browser
    const response = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/gemini-proxy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        message: msg,
        model: CONFIG.GEMINI_MODEL,
      }),
    });

    const data = await response.json();
    getEl('chat-typing')?.remove();

    if (!response.ok) {
      const errMsg = data?.error ?? `API error (${response.status})`;
      console.error('[Chatbot] Proxy error:', errMsg);
      if (response.status === 401) {
        _addChatBubble('⚠️ Session expired. Please log out and log back in.', 'bot');
      } else if (response.status === 429) {
        _addChatBubble('⏳ Rate limit reached. Please wait a moment and try again.', 'bot');
      } else {
        _addChatBubble(`⚠️ ${errMsg}`, 'bot');
      }
      return;
    }

    const reply = data.reply;
    _addChatBubble(reply ?? 'Sorry, I could not generate a response. Please try again.', 'bot');
  } catch (err) {
    console.error('[Chatbot] API error:', err);
    getEl('chat-typing')?.remove();
    _addChatBubble('🌐 Network error. Please check your connection and try again.', 'bot');
  }
}

/**
 * Append a message bubble to the chat.
 * @param {string} text
 * @param {'user'|'bot'} sender
 */
function _addChatBubble(text, sender) {
  const bubble = el('div', { className: `chat-msg ${sender}` });

  if (sender === 'bot') {
    // Safe markdown-like formatting: bold, italic, inline code
    bubble.innerHTML = esc(text)
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code style="background:rgba(0,0,0,0.06);padding:1px 4px;border-radius:3px;">$1</code>')
      .replace(/\n/g, '<br>');
  } else {
    bubble.textContent = text;
  }

  getEl('chatbot-messages')?.appendChild(bubble);
  _scrollChatToBottom();
}

function _scrollChatToBottom() {
  const msgs = getEl('chatbot-messages');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
}





/* ─────────────────────────────────────────────────────────────
   SECTION 29 — ADMIN: PDF MANAGEMENT
   ───────────────────────────────────────────────────────────── */

async function adminHandlePdfUpload(file) {
  if (!file) return;

  // Validate by extension AND mime — some browsers send 'application/octet-stream'
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!isPdf) {
    Toast.show('Please select a PDF file (.pdf only).', 'error');
    return;
  }

  if (file.size > CONFIG.MAX_PDF_BYTES) {
    Toast.show('File must be under 15 MB.', 'error');
    return;
  }

  // Validate subject BEFORE touching storage
  const sem = getEl('admin-pdf-sem')?.value ?? '1';
  const subject = getEl('admin-pdf-subject')?.value.trim() ?? '';
  if (!subject) {
    Toast.show('Please enter a subject name before selecting a file.', 'warning');
    // Reset file input so user can try again after filling subject
    const fi = getEl('admin-pdf-file-input');
    if (fi) fi.value = '';
    return;
  }

  const progressEl = getEl('admin-upload-progress');
  const progressBar = getEl('admin-upload-progress-bar');

  const _setProgress = (pct, show = true) => {
    if (progressEl) progressEl.style.display = show ? 'block' : 'none';
    if (progressBar) progressBar.style.width = `${pct}%`;
  };

  _setProgress(20);

  // Sanitise filename — remove spaces & special chars
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `sem${sem}/${subject.replace(/\s+/g, '_')}/${Date.now()}_${safeName}`;

  try {
    _setProgress(40);

    const { error: uploadError } = await supa.storage
      .from('pdfs')
      .upload(storagePath, file, {
        contentType: 'application/pdf',  // explicit — fixes silent failures
        upsert: false,                   // never silently overwrite
        cacheControl: '3600',
      });

    if (uploadError) {
      console.error('[PDF Upload] Storage error:', uploadError);
      const isNoBucket = uploadError.message?.toLowerCase().includes('bucket') ||
        uploadError.statusCode === '404' || uploadError.error === 'Bucket not found';
      const hint = isNoBucket
        ? '\n\nFix: In Supabase → Storage → New bucket → name it "pdfs" → enable Public.'
        : '';
      Toast.show(`Upload failed: ${uploadError.message}${hint}`, 'error');
      _setProgress(0, false);
      return;
    }

    _setProgress(75);

    const { data: urlData } = supa.storage.from('pdfs').getPublicUrl(storagePath);
    const publicUrl = urlData?.publicUrl;

    if (!publicUrl) {
      Toast.show('Could not get public URL. Check storage bucket is public.', 'error');
      _setProgress(0, false);
      return;
    }

    const { error: dbError } = await supa.from('admin_pdfs').insert({
      name: file.name,
      url: publicUrl,
      storage_path: storagePath,
      sem,
      subject,
      size: file.size,
    });

    if (dbError) {
      console.error('[PDF Upload] DB insert error:', dbError);
      Toast.show(`Database error: ${dbError.message}`, 'error');
      _setProgress(0, false);
      return;
    }

    _setProgress(100);
    setTimeout(() => _setProgress(0, false), 600);

    const fileInput = getEl('admin-pdf-file-input');
    if (fileInput) fileInput.value = '';
    const subjectInput = getEl('admin-pdf-subject');
    if (subjectInput) subjectInput.value = '';

    Toast.show(`"${file.name}" uploaded successfully! 📄`, 'success');
    adminLoadPdfs();

  } catch (err) {
    console.error('[PDF Upload] Unexpected error:', err);
    Toast.show('Unexpected error during upload. Check console.', 'error');
    _setProgress(0, false);
  }
}

async function adminLoadPdfs() {
  const { data } = await supa.from('admin_pdfs')
    .select('*')
    .order('uploaded_at', { ascending: false });

  const container = getEl('admin-pdf-list');
  if (!container) return;
  container.innerHTML = '';

  if (!data?.length) {
    container.appendChild(el('p', {
      style: { color: 'var(--text-muted)', fontSize: '0.85rem' },
      textContent: 'No PDFs uploaded yet.',
    }));
    return;
  }

  data.forEach(d => {
    const sizeStr = d.size > 1_048_576
      ? `${(d.size / 1_048_576).toFixed(1)} MB`
      : `${Math.round(d.size / 1024)} KB`;

    container.appendChild(el('div', { className: 'pdf-item' }, [
      el('div', { className: 'pdf-icon', textContent: '📕' }),
      el('div', { className: 'pdf-info' }, [
        el('div', { className: 'pdf-name', textContent: d.name }),
        el('div', { className: 'pdf-meta', textContent: `Sem ${d.sem} · ${d.subject} · ${sizeStr}` }),
      ]),
      el('div', { className: 'pdf-actions' }, [
        el('a', { href: d.url, target: '_blank', rel: 'noopener noreferrer', className: 'btn-download', textContent: '👁️ View' }),
        el('button', {
          className: 'btn-delete',
          textContent: '✕',
          'aria-label': `Delete ${d.name}`,
          onClick: async () => {
            if (!confirm(`Delete "${d.name}"? This cannot be undone.`)) return;
            await supa.storage.from('pdfs').remove([d.storage_path]);
            await supa.from('admin_pdfs').delete().eq('id', d.id);
            Toast.show('PDF deleted.', 'warning');
            adminLoadPdfs();
          },
        }),
      ]),
    ]));
  });
}


/* ─────────────────────────────────────────────────────────────
   SECTION 30 — ADMIN: USER MANAGEMENT
   Displays rich profile cards with activity stats.
   ───────────────────────────────────────────────────────────── */

async function adminLoadUsers() {
  const container = getEl('admin-users-container');
  if (!container) return;
  container.innerHTML = '<p class="att-loading">Loading users…</p>';

  // Parallel fetch: profiles + activity data
  const [prRes, strRes, taskRes, progRes] = await Promise.all([
    supa.from('profiles').select('*', { count: 'exact' }),
    supa.from('streak_log').select('user_id, date').order('date', { ascending: false }),
    supa.from('tasks').select('user_id, done'),
    supa.from('progress').select('user_id, marks'),
  ]);

  const profiles = prRes.data ?? [];
  const streaks = strRes.data ?? [];
  const tasks = taskRes.data ?? [];
  const progress = progRes.data ?? [];
  const count = prRes.count ?? profiles.length;

  const countEl = getEl('admin-user-count');
  if (countEl) countEl.textContent = count;

  container.innerHTML = '';

  if (!profiles.length) {
    container.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:24px;">No students have saved a profile yet.</p>';
    return;
  }

  // Live search bar
  const searchInput = el('input', {
    type: 'search',
    placeholder: '🔍 Search name, reg, phone…',
    'aria-label': 'Search students',
    className: 'admin-user-search',
  });
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.toLowerCase();
    container.querySelectorAll('.aur-card').forEach(card => {
      card.style.display = card.dataset.search?.includes(q) ? '' : 'none';
    });
  });
  container.appendChild(searchInput);
  container.appendChild(el('p', {
    style: { fontSize: '0.8rem', color: 'var(--text-muted)', margin: '4px 0 14px' },
    textContent: `${profiles.length} student${profiles.length !== 1 ? 's' : ''} registered`,
  }));

  profiles.forEach(p => {
    // Streak — use Set for O(1) lookups instead of Array.includes
    const userDateSet = new Set(
      streaks.filter(s => s.user_id === p.user_id).map(s => s.date)
    );
    let streak = 0, cur = new Date();
    for (let i = 0; i < 365; i++) {
      const d = cur.toISOString().split('T')[0];
      if (userDateSet.has(d)) { streak++; cur.setDate(cur.getDate() - 1); } else break;
    }

    // Tasks
    const ut = tasks.filter(t => t.user_id === p.user_id);
    const doneTasks = ut.filter(t => t.done).length;

    // CGPA
    const up = progress.filter(r => r.user_id === p.user_id);
    const cgpa = up.length ? (up.reduce((s, r) => s + r.marks, 0) / up.length).toFixed(2) : '—';

    // Last active
    const lastActive = userDates[0] ?? null;

    const searchText = [p.name, p.reg, p.phone, p.adm, p.act, p.user_id]
      .filter(Boolean).join(' ').toLowerCase();

    const card = el('div', { className: 'aur-card', 'data-search': searchText });

    // Avatar + identity
    const header = el('div', { className: 'aur-header' }, [
      el('div', { className: 'admin-user-avatar', textContent: (p.name ?? 'U')[0].toUpperCase(), 'aria-hidden': 'true' }),
      el('div', { className: 'aur-identity' }, [
        el('strong', { textContent: p.name ?? 'Unknown Student' }),
        lastActive
          ? el('span', { className: 'aur-badge-active', textContent: `Last active: ${lastActive}` })
          : el('span', { className: 'aur-badge-inactive', textContent: 'Not yet active' }),
      ]),
    ]);
    card.appendChild(header);

    // Detail chips
    const chips = el('div', { className: 'aur-chips' });
    if (p.reg) chips.appendChild(el('span', { className: 'aur-chip', textContent: `🎫 ${p.reg}` }));
    if (p.phone) chips.appendChild(el('span', { className: 'aur-chip', textContent: `📞 ${p.phone}` }));
    if (p.adm) chips.appendChild(el('span', { className: 'aur-chip', textContent: `🏫 ${p.adm}` }));
    if (p.act) chips.appendChild(el('span', { className: 'aur-chip', textContent: `🏆 ${p.act}` }));
    if (chips.children.length) card.appendChild(chips);

    // Mini stats
    card.appendChild(el('div', { className: 'aur-stats' }, [
      el('div', { className: 'aur-stat' }, [
        el('span', { className: 'aur-stat-val', textContent: cgpa }),
        el('span', { className: 'aur-stat-lbl', textContent: 'CGPA' }),
      ]),
      el('div', { className: 'aur-stat' }, [
        el('span', { className: 'aur-stat-val', textContent: `🔥 ${streak}` }),
        el('span', { className: 'aur-stat-lbl', textContent: 'Streak' }),
      ]),
      el('div', { className: 'aur-stat' }, [
        el('span', { className: 'aur-stat-val', textContent: ut.length ? `${doneTasks}/${ut.length}` : '—' }),
        el('span', { className: 'aur-stat-lbl', textContent: 'Tasks' }),
      ]),
      el('div', { className: 'aur-stat' }, [
        el('span', { className: 'aur-stat-val', textContent: up.length ? `S${up.length}` : '—' }),
        el('span', { className: 'aur-stat-lbl', textContent: 'Progress' }),
      ]),
    ]));

    container.appendChild(card);
  });
}


/* ─────────────────────────────────────────────────────────────
   SECTION 30.5 — STUDY REQUESTS
   ───────────────────────────────────────────────────────────── */

async function submitStudyRequestOld() {
  if (!currentUser) return;
  const subject = getEl('sr-subject')?.value.trim();
  const examDate = getEl('sr-exam-date')?.value;
  const difficulty = getEl('sr-difficulty')?.value;

  if (!subject || !examDate) {
    Toast.show('Please fill in both subject and exam date.', 'warning');
    return;
  }

  const { error } = await supa.from('study_requests').insert({
    user_id: currentUser.id,
    subject,
    exam_date: examDate,
    difficulty,
    status: 'pending'
  });

  if (error) {
    Toast.show(`Failed to send request: ${error.message}`, 'error');
    return;
  }

  Toast.show('Study request sent successfully!', 'success');
  if (getEl('sr-subject')) getEl('sr-subject').value = '';
  if (getEl('sr-exam-date')) getEl('sr-exam-date').value = '';
  if (getEl('sr-difficulty')) getEl('sr-difficulty').value = 'easy';
  loadStudyRequests();
}

async function loadStudyRequestsOld() {
  if (!currentUser) return;

  const container = getEl('student-requests-container');
  if (!container) return;

  const { data, error } = await supa.from('study_requests')
    .select('*')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[StudyRequest] loadStudyRequests error:', error);
    return;
  }

  container.innerHTML = '';
  if (!data || !data.length) {
    container.textContent = 'You have not submitted any study requests.';
    Object.assign(container.style, { color: 'var(--text-muted)', fontSize: '0.88rem' });
    return;
  }

  data.forEach(req => {
    const isEditing = req.status === 'pending';
    const borderColor = req.status === 'pending' ? 'var(--warning-main)' : 'var(--success-main)';
    const card = el('div', { className: 'task-item', style: { flexDirection: 'column', alignItems: 'flex-start', borderLeft: `4px solid ${borderColor}`, padding: '12px', marginBottom: '8px' } }, [
      el('div', { style: { display: 'flex', justifyContent: 'space-between', width: '100%', marginBottom: '8px' } }, [
        el('strong', { textContent: `📚 ${req.subject}` }),
        el('span', { className: req.status === 'pending' ? 'aur-badge-inactive' : 'aur-badge-active', textContent: req.status.toUpperCase() })
      ]),
      el('div', { style: { fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: '4px' } }, [
        el('span', { textContent: `📅 Exam: ${req.exam_date} | ⚡ Difficulty: ${req.difficulty.toUpperCase()}` })
      ])
    ]);

    if (req.status === 'responded' && req.response_text) {
      card.appendChild(el('div', { style: { marginTop: '8px', padding: '10px', background: 'var(--bg-gray)', borderRadius: '6px', width: '100%', fontSize: '0.88rem', border: '1px solid var(--glass-border)' } }, [
        el('strong', { textContent: '👑 Admin Timetable: ' }),
        el('div', { innerHTML: req.response_text.replace(/\n/g, '<br>') })
      ]));
    } else {
      card.appendChild(el('div', { style: { marginTop: '8px', fontSize: '0.82rem', fontStyle: 'italic', color: 'var(--text-muted)' }, textContent: 'Waiting for admin to provide a timetable...' }));
    }
    container.appendChild(card);
  });
}

async function adminLoadStudyRequests() {
  const container = getEl('admin-requests-container');
  const countBadge = getEl('admin-request-count');
  if (!container) return;

  const filter = getEl('admin-request-filter')?.value || 'all';

  // Try to query with user metadata join if permissions allow
  let query = supa.from('study_requests').select('*, users:user_id(email)').order('created_at', { ascending: false });
  if (filter !== 'all') {
    query = query.eq('status', filter);
  }

  const { data, error } = await query;

  if (error) {
    console.error('[Admin] adminLoadStudyRequests error with joined query, falling back:', error);
    // fallback without trying to join auth.users if permissions block it
    const fallbackQuery = supa.from('study_requests').select('*').order('created_at', { ascending: false });
    const fallbackRes = filter !== 'all' ? await fallbackQuery.eq('status', filter) : await fallbackQuery;
    if (fallbackRes.error) return;
    return renderAdminRequests(container, countBadge, fallbackRes.data);
  }

  renderAdminRequests(container, countBadge, data);
}

function renderAdminRequests(container, countBadge, data) {
  if (countBadge) countBadge.textContent = data.length.toString();

  container.innerHTML = '';
  if (!data || !data.length) {
    container.textContent = 'No requests found matching the filter.';
    Object.assign(container.style, { color: 'var(--text-muted)', fontSize: '0.88rem', padding: '10px' });
    return;
  }

  data.forEach(req => {
    let studentName = 'Student ID: ' + req.user_id.substring(0, 8) + '...';
    if (req.users && req.users.email) {
      studentName = 'Student: ' + req.users.email;
    }

    const card = el('div', { className: 'card-panel', style: { marginBottom: '15px', padding: '16px' } }, [
      el('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '10px' } }, [
        el('div', {}, [
          el('h4', { style: { margin: '0 0 6px 0', color: 'var(--text-dark)' }, textContent: `📚 ${req.subject}` }),
          el('div', { style: { fontSize: '0.85rem', color: 'var(--text-muted)' } }, [
            el('span', { textContent: studentName }),
            el('br'),
            el('span', { textContent: `📅 Exam Date: ${req.exam_date} | ⚡ Difficulty: ${req.difficulty.toUpperCase()}` })
          ])
        ]),
        el('span', { className: req.status === 'pending' ? 'aur-badge-inactive' : 'aur-badge-active', textContent: req.status.toUpperCase() })
      ])
    ]);

    if (req.status === 'pending') {
      const responseContainer = el('div', { style: { marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' } });
      const textAreaId = `admin-response-${req.id}`;
      responseContainer.appendChild(el('textarea', { id: textAreaId, placeholder: 'Write a suitable timetable or instructions here...', rows: '4', style: { width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid var(--border-input)', background: 'var(--bg-card)', fontSize: '0.9rem', resize: 'vertical' } }));
      responseContainer.appendChild(el('button', { className: 'btn-action', textContent: 'Send Timetable', onClick: () => adminRespondToRequest(req.id, textAreaId), style: { alignSelf: 'flex-start' } }));
      card.appendChild(responseContainer);
    } else {
      card.appendChild(el('div', { style: { padding: '12px', background: 'var(--bg-gray)', borderRadius: '6px', fontSize: '0.88rem', marginTop: '12px', border: '1px solid var(--glass-border)' } }, [
        el('strong', { textContent: 'Your Response: ' }),
        el('div', { innerHTML: (req.response_text || '').replace(/\n/g, '<br>'), style: { marginTop: '6px' } })
      ]));
    }

    container.appendChild(card);
  });
}

async function adminRespondToRequest(requestId, textareaId) {
  const responseText = getEl(textareaId)?.value.trim();
  if (!responseText) {
    Toast.show('Please enter a response timetable.', 'warning');
    return;
  }

  const btn = event.target;
  const originalText = btn.textContent;
  btn.textContent = 'Sending...';
  btn.disabled = true;

  const { error } = await supa.from('study_requests').update({
    status: 'responded',
    response_text: responseText
  }).eq('id', requestId);

  btn.disabled = false;
  btn.textContent = originalText;

  if (error) {
    Toast.show(`Failed to send response: ${error.message}`, 'error');
    return;
  }

  Toast.show('Timetable sent successfully!', 'success');
  adminLoadStudyRequests();
}


/* ─────────────────────────────────────────────────────────────
   SECTION 31 — KEYBOARD SHORTCUTS
   ───────────────────────────────────────────────────────────── */

const SHORTCUTS = Object.freeze({
  'd': 'dashboard',
  't': 'timetable',
  'r': 'reminders',
  'n': 'notes',
  'p': 'pomodoro',
  'k': 'tasks',
});

document.addEventListener('keydown', e => {
  // Ignore shortcuts when user is typing
  const tag = document.activeElement?.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (!currentUser || isAdmin()) return;

  if (!e.altKey) return;

  if (e.key === 'c') { e.preventDefault(); toggleChatbot(); return; }

  const section = SHORTCUTS[e.key];
  if (section) { e.preventDefault(); navigateTo(section); }
});


/* ─────────────────────────────────────────────────────────────
   SECTION 32 — PWA SERVICE WORKER
   ───────────────────────────────────────────────────────────── */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => {
      console.warn('[PWA] Service worker registration failed:', err);
    });
  });
}
