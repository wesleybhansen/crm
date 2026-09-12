'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

// ── Types ──
type Lesson = {
  id: string; title: string; contentType: string; content: string | null; description: string | null
  videoUrl: string | null; fileUrl: string | null; durationMinutes: number | null; isFreePreview: boolean
  isCompleted: boolean; isLocked: boolean; unlockDate: string | null
}
type Module = { id: string; title: string; description: string; lessons: Lesson[] }
type CourseData = {
  course: { id: string; title: string; description: string; imageUrl: string | null }
  enrollmentId: string; modules: Module[]
  progress: { totalLessons: number; completedCount: number; percentage: number }
}

function getVideoEmbed(url: string | null): string | null {
  if (!url) return null
  const yt = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]+)/)
  if (yt) return `https://www.youtube.com/embed/${yt[1]}`
  const vm = url.match(/vimeo\.com\/(\d+)/)
  if (vm) return `https://player.vimeo.com/video/${vm[1]}`
  const lm = url.match(/loom\.com\/share\/([a-zA-Z0-9]+)/)
  if (lm) return `https://www.loom.com/embed/${lm[1]}`
  return null
}

function renderMarkdown(md: string): string {
  let safe = md
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/javascript\s*:/gi, '')
  return safe
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>')
}

export default function StudentCoursePage() {
  const [mode, setMode] = useState<'loading' | 'login' | 'course'>('loading')
  const [courseData, setCourseData] = useState<CourseData | null>(null)
  const [selectedLessonId, setSelectedLessonId] = useState<string | null>(null)
  const [loginEmail, setLoginEmail] = useState('')
  const [loginSending, setLoginSending] = useState(false)
  const [loginSent, setLoginSent] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [completing, setCompleting] = useState(false)

  // AI Tutor chat
  const [chatOpen, setChatOpen] = useState(false)
  const [chatMessages, setChatMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([])
  const [chatInput, setChatInput] = useState('')
  const [chatSending, setChatSending] = useState(false)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const chatInputRef = useRef<HTMLInputElement>(null)

  const slug = typeof window !== 'undefined' ? window.location.pathname.split('/')[2] : ''

  const loadCourse = useCallback(async () => {
    try {
      const res = await fetch(`/api/courses/student/course/${slug}`, { credentials: 'include' })
      const d = await res.json()
      if (d.ok) {
        setCourseData(d.data)
        setMode('course')
        for (const mod of d.data.modules) {
          for (const les of mod.lessons) {
            if (!les.isCompleted && !les.isLocked) { setSelectedLessonId(les.id); return }
          }
        }
        if (d.data.modules[0]?.lessons[0]) setSelectedLessonId(d.data.modules[0].lessons[0].id)
      } else { setMode('login') }
    } catch { setMode('login') }
  }, [slug])

  useEffect(() => { if (slug) loadCourse() }, [slug, loadCourse])

  const handleLogin = async () => {
    if (!loginEmail.trim()) return
    setLoginSending(true)
    await fetch('/api/courses/student/magic-link', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: loginEmail, courseSlug: slug }),
    })
    setLoginSent(true); setLoginSending(false)
  }

  const markComplete = async (lessonId: string) => {
    if (!courseData) return
    setCompleting(true)
    const res = await fetch('/api/courses/student/progress', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enrollmentId: courseData.enrollmentId, lessonId }),
    })
    if ((await res.json()).ok) loadCourse()
    setCompleting(false)
  }

  // AI Tutor greeting on first open
  const greetedRef = useRef(false)
  useEffect(() => {
    if (chatOpen && courseData && chatMessages.length === 0 && !greetedRef.current) {
      greetedRef.current = true
      setChatMessages([{ role: 'assistant', content: `Welcome to **${courseData.course.title}**! 👋\n\nI'm your AI tutor — I know this course inside and out. Ask me anything about the lessons, concepts, or how to apply what you're learning.\n\nWhat would you like to know?` }])
    }
  }, [chatOpen, courseData])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages])

  async function sendChat() {
    if (!chatInput.trim() || !courseData || chatSending) return
    const userMsg = chatInput.trim()
    setChatInput('')
    setChatMessages(prev => [...prev, { role: 'user', content: userMsg }])
    setChatSending(true)
    try {
      const res = await fetch('/api/courses/student/chat', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          courseId: courseData.course.id,
          lessonId: selectedLessonId,
          message: userMsg,
          history: chatMessages.slice(-8),
        }),
      })
      const d = await res.json()
      if (d.ok && d.data?.reply) {
        setChatMessages(prev => [...prev, { role: 'assistant', content: d.data.reply }])
      } else {
        setChatMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, I couldn\'t process that. Please try again.' }])
      }
    } catch {
      setChatMessages(prev => [...prev, { role: 'assistant', content: 'Something went wrong. Please try again.' }])
    }
    setChatSending(false)
    setTimeout(() => chatInputRef.current?.focus(), 100)
  }

  // Navigate lessons
  const allLessons = courseData?.modules.flatMap(m => m.lessons) || []
  const currentIdx = allLessons.findIndex(l => l.id === selectedLessonId)
  const prevLesson = currentIdx > 0 ? allLessons[currentIdx - 1] : null
  const nextLesson = currentIdx < allLessons.length - 1 ? allLessons[currentIdx + 1] : null

  let selectedLesson: Lesson | null = null
  let selectedModule: Module | null = null
  if (courseData && selectedLessonId) {
    for (const mod of courseData.modules) {
      const les = mod.lessons.find(l => l.id === selectedLessonId)
      if (les) { selectedLesson = les; selectedModule = mod; break }
    }
  }

  const embedUrl = selectedLesson ? getVideoEmbed(selectedLesson.videoUrl) : null

  // ── Styles ──
  const css = `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
    body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #fafafa; }
    ::selection { background: #c7d2fe; color: #1e1b4b; }
    .prose h1 { font-size: 26px; font-weight: 700; margin: 32px 0 14px; color: #0f172a; letter-spacing: -0.02em; line-height: 1.3; }
    .prose h2 { font-size: 22px; font-weight: 700; margin: 28px 0 12px; color: #0f172a; letter-spacing: -0.015em; line-height: 1.3; }
    .prose h3 { font-size: 18px; font-weight: 600; margin: 24px 0 10px; color: #1e293b; line-height: 1.4; }
    .prose p { margin-bottom: 16px; line-height: 1.75; color: #475569; font-size: 16px; }
    .prose strong { font-weight: 600; color: #1e293b; }
    .prose code { background: #f1f5f9; padding: 2px 7px; border-radius: 5px; font-size: 14px; font-family: 'SF Mono', 'Fira Code', Monaco, monospace; color: #7c3aed; }
    .prose li { margin-left: 24px; margin-bottom: 8px; line-height: 1.7; color: #475569; }
    .prose ul, .prose ol { margin-bottom: 16px; }
    .prose blockquote { border-left: 3px solid #6366f1; padding-left: 16px; margin: 20px 0; color: #64748b; font-style: italic; }
    .prose a { color: #6366f1; text-decoration: underline; text-underline-offset: 2px; }
    .prose a:hover { color: #4f46e5; }
    .prose img { max-width: 100%; border-radius: 8px; margin: 16px 0; }
    .sidebar-item { width: 100%; text-align: left; padding: 11px 16px 11px 20px; display: flex; align-items: center; gap: 12px; font-size: 13.5px; border: none; cursor: pointer; font-family: inherit; transition: all 150ms ease; border-left: 3px solid transparent; background: transparent; color: #475569; }
    .sidebar-item:hover { background: rgba(99,102,241,0.04); color: #1e293b; }
    .sidebar-item.active { background: rgba(99,102,241,0.08); border-left-color: #6366f1; font-weight: 600; color: #4f46e5; }
    .sidebar-item.locked { color: #cbd5e1; cursor: not-allowed; }
    .sidebar-item.locked:hover { background: transparent; color: #cbd5e1; }
    .sidebar-item.completed .title { color: #94a3b8; text-decoration: line-through; text-decoration-color: #d1d5db; }
    .complete-btn { width: 100%; max-width: 680px; padding: 15px; background: linear-gradient(135deg, #22c55e, #16a34a); color: #fff; border: none; border-radius: 10px; font-size: 15px; font-weight: 600; cursor: pointer; font-family: inherit; transition: all 200ms ease; box-shadow: 0 2px 8px rgba(34,197,94,0.3); letter-spacing: -0.01em; }
    .complete-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(34,197,94,0.4); }
    .complete-btn:active { transform: translateY(0); }
    .complete-btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; box-shadow: none; }
    .nav-btn { padding: 10px 20px; background: #fff; color: #475569; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; font-family: inherit; transition: all 150ms ease; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .nav-btn:hover { background: #f8fafc; border-color: #cbd5e1; color: #1e293b; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
    .content-type-badge { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; background: #f1f5f9; border-radius: 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-bottom: 12px; }
    .chat-panel { position: fixed; right: 0; top: 3px; bottom: 0; width: 380px; background: #fff; border-left: 1px solid #eef0f4; display: flex; flex-direction: column; z-index: 30; box-shadow: -4px 0 24px rgba(0,0,0,0.06); }
    .chat-msg { padding: 12px 16px; font-size: 14px; line-height: 1.65; }
    .chat-msg.user { background: #f8fafc; }
    .chat-msg.assistant { background: #fff; }
    .chat-msg strong { font-weight: 600; color: #0f172a; }
    .chat-msg code { background: #f1f5f9; padding: 1px 5px; border-radius: 4px; font-size: 13px; }
    .chat-msg li { margin-left: 18px; margin-bottom: 4px; }
    .chat-msg p { margin-bottom: 8px; }
    .chat-msg p:last-child { margin-bottom: 0; }
    .chat-fab { position: fixed; right: 24px; bottom: 24px; width: 52px; height: 52px; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; border: none; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 16px rgba(99,102,241,0.4); z-index: 25; transition: all 200ms; }
    .chat-fab:hover { transform: scale(1.08); box-shadow: 0 6px 24px rgba(99,102,241,0.5); }
    @media (max-width: 768px) {
      .sidebar { position: fixed !important; left: 0; top: 0; bottom: 0; z-index: 50; box-shadow: 4px 0 24px rgba(0,0,0,0.12); transform: translateX(0); }
      .sidebar-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 40; backdrop-filter: blur(2px); }
      .lesson-content-area { padding: 24px 20px 60px !important; }
      .chat-panel { width: 100%; }
    }
  `

  // ── Login ──
  if (mode === 'login') {
    return (
      <>
        <style dangerouslySetInnerHTML={{ __html: css }} />
        <div style={{ background: 'linear-gradient(160deg, #f8faff 0%, #f1f5f9 40%, #faf5ff 100%)', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
          <div style={{ background: '#fff', borderRadius: '20px', boxShadow: '0 1px 2px rgba(0,0,0,.03), 0 8px 32px rgba(0,0,0,.06), 0 24px 60px rgba(0,0,0,.04)', maxWidth: '420px', width: '100%', padding: '48px 40px', textAlign: 'center' }}>
            {loginSent ? (
              <>
                <div style={{ width: '56px', height: '56px', background: '#f0fdf4', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>
                </div>
                <h2 style={{ fontSize: '22px', fontWeight: 700, marginBottom: '8px', color: '#1a1a2e' }}>Check your email</h2>
                <p style={{ color: '#64748b', fontSize: '15px', lineHeight: 1.6 }}>We sent an access link to <strong style={{ color: '#374151' }}>{loginEmail}</strong>. Click the link to access your course.</p>
                <p style={{ color: '#94a3b8', fontSize: '13px', marginTop: '16px', lineHeight: 1.5 }}>Links are valid for 7 days. If yours has expired, come back here and request a new one.</p>
              </>
            ) : (
              <>
                <div style={{ width: '48px', height: '48px', background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 24px' }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" /></svg>
                </div>
                <h2 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '8px', color: '#1a1a2e', letterSpacing: '-0.01em' }}>Welcome back</h2>
                <p style={{ color: '#64748b', fontSize: '15px', marginBottom: '28px', lineHeight: 1.5 }}>Enter your email to get an instant access link.</p>
                <input type="email" value={loginEmail} onChange={e => setLoginEmail(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleLogin() }}
                  placeholder="your@email.com"
                  style={{ width: '100%', padding: '13px 16px', border: '1.5px solid #e2e8f0', borderRadius: '8px', fontSize: '15px', marginBottom: '12px', outline: 'none', boxSizing: 'border-box', transition: 'border-color 200ms', fontFamily: 'inherit' }}
                  onFocus={e => e.target.style.borderColor = '#6366f1'}
                  onBlur={e => e.target.style.borderColor = '#e2e8f0'} />
                <button onClick={handleLogin} disabled={loginSending || !loginEmail.trim()}
                  style={{ width: '100%', padding: '13px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '15px', fontWeight: 600, cursor: 'pointer', opacity: loginSending ? 0.6 : 1, fontFamily: 'inherit', transition: 'background 150ms' }}>
                  {loginSending ? 'Sending...' : 'Get Access Link'}
                </button>
              </>
            )}
          </div>
        </div>
      </>
    )
  }

  if (mode === 'loading' || !courseData) {
    return (
      <>
        <style dangerouslySetInnerHTML={{ __html: css }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#fafafa' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ width: '32px', height: '32px', border: '3px solid #e2e8f0', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 16px' }} />
            <div style={{ color: '#94a3b8', fontSize: '14px', fontWeight: 500 }}>Loading course...</div>
            <style dangerouslySetInnerHTML={{ __html: '@keyframes spin { to { transform: rotate(360deg) } }' }} />
          </div>
        </div>
      </>
    )
  }

  // ── Course Player ──
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: css }} />

      {/* Global progress bar */}
      <div style={{ position: 'fixed', top: 0, left: 0, right: 0, height: '3px', background: '#e2e8f0', zIndex: 100 }}>
        <div style={{ height: '100%', background: 'linear-gradient(90deg, #6366f1, #8b5cf6)', width: `${courseData.progress.percentage}%`, transition: 'width 500ms ease', borderRadius: '0 2px 2px 0' }} />
      </div>

      <div style={{ display: 'flex', height: '100vh', paddingTop: '3px' }}>
        {/* Mobile overlay */}
        {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} style={{ display: 'none' }} />}

        {/* Sidebar */}
        {sidebarOpen && (
          <div className="sidebar" style={{ width: '300px', borderRight: '1px solid #eef0f4', display: 'flex', flexDirection: 'column', background: '#fafbfc', flexShrink: 0 }}>
            <div style={{ padding: '24px 20px 20px', borderBottom: '1px solid #eef0f4' }}>
              <h1 style={{ fontSize: '14px', fontWeight: 700, color: '#0f172a', marginBottom: '14px', lineHeight: 1.5, letterSpacing: '-0.01em' }}>{courseData.course.title}</h1>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ flex: 1, background: '#e2e8f0', borderRadius: '4px', height: '5px', overflow: 'hidden' }}>
                  <div style={{ background: 'linear-gradient(90deg, #22c55e, #4ade80)', height: '100%', width: `${courseData.progress.percentage}%`, borderRadius: '4px', transition: 'width 500ms ease' }} />
                </div>
                <span style={{ fontSize: '12px', color: '#64748b', fontWeight: 600, whiteSpace: 'nowrap' }}>{courseData.progress.percentage}%</span>
              </div>
              <p style={{ fontSize: '11px', color: '#94a3b8', marginTop: '6px' }}>{courseData.progress.completedCount} of {courseData.progress.totalLessons} lessons completed</p>
            </div>

            <div style={{ flex: 1, overflowY: 'auto' }}>
              {courseData.modules.map(mod => (
                <div key={mod.id}>
                  <div style={{ padding: '16px 20px 6px', fontSize: '10.5px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{mod.title}</div>
                  {mod.lessons.map(les => (
                    <button key={les.id} onClick={() => !les.isLocked && setSelectedLessonId(les.id)}
                      className={`sidebar-item ${les.id === selectedLessonId ? 'active' : ''} ${les.isLocked ? 'locked' : ''} ${les.isCompleted ? 'completed' : ''}`}>
                      <span style={{ width: '20px', height: '20px', borderRadius: '50%', border: les.isCompleted ? 'none' : les.isLocked ? '1.5px solid #e2e8f0' : '2px solid #d1d5db', background: les.isCompleted ? 'linear-gradient(135deg, #22c55e, #16a34a)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 200ms ease' }}>
                        {les.isCompleted && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>}
                        {les.isLocked && <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" strokeWidth="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>}
                      </span>
                      <span className="title" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{les.title}</span>
                      {les.durationMinutes && <span style={{ fontSize: '11px', color: '#94a3b8', flexShrink: 0 }}>{les.durationMinutes}m</span>}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Main content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: '#fff' }}>
          {/* Top bar */}
          <div style={{ padding: '10px 24px', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, background: '#fff' }}>
            <button onClick={() => setSidebarOpen(!sidebarOpen)}
              style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '7px 14px', cursor: 'pointer', fontSize: '13px', color: '#64748b', fontFamily: 'inherit', transition: 'all 150ms', display: 'flex', alignItems: 'center', gap: '6px' }}>
              {sidebarOpen ? (
                <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" d="M11 19l-7-7 7-7M4 12h16"/></svg>Hide</>
              ) : (
                <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="7" x2="21" y2="7"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="17" x2="21" y2="17"/></svg>Menu</>
              )}
            </button>
            {selectedModule && selectedLesson && (
              <div style={{ fontSize: '13px', color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '500px' }}>
                <span style={{ color: '#64748b', fontWeight: 500 }}>{selectedModule.title}</span>
                <span style={{ margin: '0 8px', color: '#d1d5db' }}>/</span>
                <span>{selectedLesson.title}</span>
              </div>
            )}
            <div style={{ width: '80px' }} />
          </div>

          {/* Lesson content */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {!selectedLesson ? (
              <div style={{ textAlign: 'center', padding: '100px 24px' }}>
                <div style={{ width: '56px', height: '56px', background: '#f1f5f9', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
                </div>
                <p style={{ fontSize: '15px', color: '#94a3b8', fontWeight: 500 }}>Select a lesson to begin</p>
              </div>
            ) : selectedLesson.isLocked ? (
              <div style={{ textAlign: 'center', padding: '100px 24px' }}>
                <div style={{ width: '64px', height: '64px', background: 'linear-gradient(135deg, #f1f5f9, #e2e8f0)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 24px' }}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                </div>
                <h2 style={{ fontSize: '22px', fontWeight: 700, color: '#0f172a', marginBottom: '10px', letterSpacing: '-0.02em' }}>Lesson Locked</h2>
                <p style={{ color: '#64748b', fontSize: '15px', lineHeight: 1.6 }}>This lesson unlocks on {new Date(selectedLesson.unlockDate!).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })}</p>
              </div>
            ) : (
              <div className="lesson-content-area" style={{ maxWidth: '800px', margin: '0 auto', padding: '44px 48px 80px' }}>
                {/* Video */}
                {(selectedLesson.contentType === 'video' || selectedLesson.contentType === 'hybrid') && embedUrl && (
                  <div style={{ borderRadius: '14px', overflow: 'hidden', background: '#0f172a', aspectRatio: '16/9', marginBottom: '36px', boxShadow: '0 8px 32px rgba(0,0,0,0.15)' }}>
                    <iframe src={embedUrl} style={{ width: '100%', height: '100%', border: 'none' }} allowFullScreen />
                  </div>
                )}

                {/* Content type badge */}
                {selectedLesson.contentType && (
                  <span className="content-type-badge">
                    {selectedLesson.contentType === 'video' ? (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    ) : selectedLesson.contentType === 'text' ? (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                    )}
                    {selectedLesson.contentType === 'video' ? 'Video Lesson' : selectedLesson.contentType === 'hybrid' ? 'Video + Text' : selectedLesson.contentType === 'text' ? 'Reading' : 'Download'}
                    {selectedLesson.durationMinutes ? ` · ${selectedLesson.durationMinutes} min` : ''}
                  </span>
                )}

                {/* Title */}
                <h1 style={{ fontSize: '30px', fontWeight: 700, color: '#0f172a', marginBottom: '24px', letterSpacing: '-0.025em', lineHeight: 1.25 }}>{selectedLesson.title}</h1>

                {/* Content */}
                {selectedLesson.content && (
                  <div className="prose" style={{ fontSize: '17px', lineHeight: 1.7, maxWidth: '680px' }}
                    dangerouslySetInnerHTML={{ __html: `<p>${renderMarkdown(selectedLesson.content)}</p>` }} />
                )}

                {/* File download */}
                {selectedLesson.fileUrl && (
                  <a href={selectedLesson.fileUrl} target="_blank" rel="noopener noreferrer"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '10px', padding: '12px 22px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px', color: '#475569', fontSize: '14px', fontWeight: 600, textDecoration: 'none', marginTop: '28px', transition: 'all 150ms' }}
                    onMouseOver={ev => { (ev.currentTarget as HTMLElement).style.background = '#f1f5f9'; (ev.currentTarget as HTMLElement).style.borderColor = '#cbd5e1' }}
                    onMouseOut={ev => { (ev.currentTarget as HTMLElement).style.background = '#f8fafc'; (ev.currentTarget as HTMLElement).style.borderColor = '#e2e8f0' }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                    Download Lesson Files
                  </a>
                )}

                {/* Bottom actions */}
                <div style={{ marginTop: '48px', paddingTop: '28px', borderTop: '1px solid #eef0f4' }}>
                  {/* Complete and Continue */}
                  {!selectedLesson.isCompleted ? (
                    <button className="complete-btn" onClick={() => markComplete(selectedLesson!.id)} disabled={completing}>
                      {completing ? 'Saving...' : nextLesson ? 'Complete and Continue' : 'Complete Course'}
                    </button>
                  ) : (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', color: '#22c55e', fontSize: '14px', fontWeight: 600, marginBottom: '16px', padding: '8px 16px', background: '#f0fdf4', borderRadius: '8px' }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>
                      Lesson completed
                    </div>
                  )}

                  {/* Navigation */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '16px' }}>
                    {prevLesson && !prevLesson.isLocked ? (
                      <button className="nav-btn" onClick={() => setSelectedLessonId(prevLesson.id)}>
                        ← {prevLesson.title}
                      </button>
                    ) : <div />}
                    {nextLesson && !nextLesson.isLocked && selectedLesson.isCompleted ? (
                      <button className="nav-btn" onClick={() => setSelectedLessonId(nextLesson.id)}>
                        {nextLesson.title} →
                      </button>
                    ) : <div />}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* AI Tutor FAB */}
      {!chatOpen && (
        <button className="chat-fab" onClick={() => setChatOpen(true)} title="Ask AI Tutor">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
        </button>
      )}

      {/* AI Tutor Chat Panel */}
      {chatOpen && (
        <div className="chat-panel">
          <div style={{ padding: '14px 16px', borderBottom: '1px solid #eef0f4', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ width: '32px', height: '32px', background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M12 6V2m0 4a4 4 0 100 8 4 4 0 000-8zm-8 8a8 8 0 0016 0" /><circle cx="12" cy="10" r="3" /></svg>
              </div>
              <div>
                <div style={{ fontSize: '14px', fontWeight: 700, color: '#0f172a' }}>AI Tutor</div>
                <div style={{ fontSize: '11px', color: '#94a3b8' }}>Ask anything about this course</div>
              </div>
            </div>
            <button onClick={() => setChatOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px', color: '#94a3b8' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
            {chatMessages.map((msg, i) => (
              <div key={i} className={`chat-msg ${msg.role}`}>
                <div style={{ fontSize: '10px', fontWeight: 600, color: msg.role === 'user' ? '#6366f1' : '#8b5cf6', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>
                  {msg.role === 'user' ? 'You' : 'AI Tutor'}
                </div>
                <div dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
              </div>
            ))}
            {chatSending && (
              <div className="chat-msg assistant">
                <div style={{ fontSize: '10px', fontWeight: 600, color: '#8b5cf6', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>AI Tutor</div>
                <div style={{ display: 'flex', gap: '4px', padding: '4px 0' }}>
                  <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#c7d2fe', animation: 'pulse 1s ease-in-out infinite' }} />
                  <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#c7d2fe', animation: 'pulse 1s ease-in-out infinite 0.2s' }} />
                  <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#c7d2fe', animation: 'pulse 1s ease-in-out infinite 0.4s' }} />
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <div style={{ padding: '12px 14px', borderTop: '1px solid #eef0f4', flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input ref={chatInputRef} type="text" value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat() } }}
                placeholder="Ask a question about this lesson..."
                style={{ flex: 1, padding: '10px 14px', border: '1.5px solid #e2e8f0', borderRadius: '10px', fontSize: '14px', outline: 'none', fontFamily: 'inherit', transition: 'border-color 200ms' }}
                onFocus={e => e.target.style.borderColor = '#6366f1'}
                onBlur={e => e.target.style.borderColor = '#e2e8f0'} />
              <button onClick={sendChat} disabled={chatSending || !chatInput.trim()}
                style={{ padding: '10px 14px', background: chatInput.trim() ? '#6366f1' : '#e2e8f0', color: chatInput.trim() ? '#fff' : '#94a3b8', border: 'none', borderRadius: '10px', cursor: chatInput.trim() ? 'pointer' : 'not-allowed', transition: 'all 150ms' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>
              </button>
            </div>
          </div>
        </div>
      )}

      <style dangerouslySetInnerHTML={{ __html: '@keyframes pulse { 0%,100% { opacity: 0.4 } 50% { opacity: 1 } }' }} />
    </>
  )
}
