import { useState } from 'react'
import { ArrowLeft, ArrowRight, KeyRound, Leaf, LockKeyhole, Mail, ShieldCheck, UserRound } from 'lucide-react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../useAuth'
import { Notice } from '../components'

export function AuthPage({ mode = 'login' }) {
  const isRegister = mode === 'register'
  const [values, setValues] = useState({ fullName: '', email: '', phone: '', password: '' })
  const [error, setError] = useState('')
  const [errorCode, setErrorCode] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const { login, register } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  function change(event) {
    setValues((current) => ({ ...current, [event.target.name]: event.target.value }))
  }

  async function submit(event) {
    event.preventDefault()
    setError('')
    setErrorCode('')
    setNotice('')
    setBusy(true)
    try {
      if (isRegister) {
        const { phone, ...account } = values
        const result = await register({ ...account, ...(phone.trim() ? { phone: phone.trim() } : {}) })
        setNotice(result.message || 'Account created. Check your email and click the verification link.')
      } else {
        await login({ email: values.email, password: values.password })
        navigate(location.state?.from || '/', { replace: true })
      }
    } catch (requestError) {
      setError(requestError.message)
      setErrorCode(requestError.code || '')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-aside">
        <Link to="/" className="brand brand-light"><span className="brand-mark">k</span><span>kobo<span className="brand-accent">market</span></span></Link>
        <div className="auth-aside-copy">
          <span className="eyebrow eyebrow-light"><Leaf size={14} /> Local finds, lovely people</span>
          <h1>{isRegister ? <>A good place<br />to <em>begin.</em></> : <>Welcome<br /><em>back.</em></>}</h1>
          <p>Shop small, find something special, and support the makers who make it.</p>
        </div>
        <div className="auth-aside-foot"><ShieldCheck size={16} /> Your details stay safe with us.</div>
      </div>
      <div className="auth-card-wrap">
        <Link className="back-link" to="/"><ArrowLeft size={16} /> Back to the market</Link>
        <div className="auth-card">
          <div className="auth-card-icon">{isRegister ? <UserRound size={22} /> : <LockKeyhole size={22} />}</div>
          <span className="eyebrow">{isRegister ? 'Join the community' : 'Your KoboMarket account'}</span>
          <h2>{isRegister ? 'Create your account' : 'Sign in'}</h2>
          <p className="muted">{isRegister ? 'One account for great finds and local makers.' : 'Good to have you back.'}</p>
          {error && <Notice tone="error">{error} {errorCode === 'EMAIL_NOT_VERIFIED' && <Link to="/verify-email" state={{ email: values.email }}>Resend verification email</Link>}</Notice>}
          {notice && <Notice tone="success">{notice} <Link to="/verify-email" state={{ email: values.email }}>Didn’t get a link?</Link></Notice>}
          <form className="form-stack" onSubmit={submit}>
            {isRegister && <>
              <label className="field-label">Full name
                <input name="fullName" value={values.fullName} onChange={change} autoComplete="name" required minLength="2" maxLength="100" />
              </label>
              <label className="field-label">Phone <span className="muted">(optional)</span>
                <input name="phone" value={values.phone} onChange={change} autoComplete="tel" />
              </label>
            </>}
            <label className="field-label"><Mail size={14} /> Email
              <input name="email" type="email" value={values.email} onChange={change} autoComplete="email" required />
            </label>
            <label className="field-label"><KeyRound size={14} /> Password
              <input name="password" type="password" value={values.password} onChange={change} autoComplete={isRegister ? 'new-password' : 'current-password'} required minLength="8" />
              {isRegister && <span className="field-hint">Use at least 8 characters, including a letter and a number.</span>}
            </label>
            {!isRegister && <Link className="text-link align-right" to="/forgot-password">Forgot your password?</Link>}
            <button type="submit" className="button button-primary button-wide" disabled={busy}>{busy ? 'Please wait…' : isRegister ? 'Create account' : 'Sign in'} <ArrowRight size={16} /></button>
          </form>
          <div className="auth-switch">{isRegister ? 'Already a member?' : 'New to KoboMarket?'} <Link to={isRegister ? '/login' : '/register'}>{isRegister ? 'Sign in' : 'Create an account'}</Link></div>
          {!isRegister && <p className="auth-footnote">We’ll never ask you to share your password with anyone.</p>}
        </div>
      </div>
    </div>
  )
}

export function VerifyEmailPage() {
  const [searchParams] = useSearchParams()
  const location = useLocation()
  const linkedToken = searchParams.get('token') || new URLSearchParams(window.location.hash.slice(1)).get('token') || ''
  const [token, setToken] = useState(linkedToken)
  const [email, setEmail] = useState(location.state?.email || '')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [verified, setVerified] = useState(false)

  async function verify(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    try {
      if (linkedToken) window.history.replaceState(null, '', window.location.pathname)
      const { data } = await api('/auth/verify-email', { method: 'POST', auth: false, body: { token } })
      setNotice(data.message)
      setVerified(true)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  async function resend(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const { data } = await api('/auth/resend-verification', { method: 'POST', auth: false, body: { email } })
      setNotice(data.message)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="narrow-page">
      <Link to="/login" className="back-link"><ArrowLeft size={16} /> Back to sign in</Link>
      <div className="simple-card">
        <div className="auth-card-icon"><Mail size={22} /></div>
        <span className="eyebrow">One last step</span><h1>Verify your email</h1>
        <p className="muted">{linkedToken ? 'Confirm that this is your email address to activate your account.' : 'Click the verification link in your email, or enter its token below.'}</p>
        {error && <Notice tone="error">{error}</Notice>}{notice && <Notice tone="success">{notice}</Notice>}
        {verified ? <Link className="button button-primary button-wide" to="/login">Continue to sign in</Link> : <>
          <form className="form-stack" onSubmit={verify}>
            {!linkedToken && <label className="field-label">Verification token<input value={token} onChange={(event) => setToken(event.target.value)} required /></label>}
            <button className="button button-primary button-wide" disabled={busy}>{busy ? 'Verifying…' : linkedToken ? 'Yes, it’s me — verify email' : 'Verify email'}</button>
          </form>
          <div className="form-divider">or request a new email</div>
          <form className="form-stack" onSubmit={resend}>
            <label className="field-label">Email address<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
            <button className="button button-outline button-wide" disabled={busy}>Resend verification</button>
          </form>
        </>}
      </div>
    </div>
  )
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const { data } = await api('/auth/forgot-password', { method: 'POST', auth: false, body: { email } })
      setNotice(data.message)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  return <div className="narrow-page">
    <Link to="/login" className="back-link"><ArrowLeft size={16} /> Back to sign in</Link>
    <div className="simple-card">
      <div className="auth-card-icon"><KeyRound size={22} /></div>
      <span className="eyebrow">Account help</span><h1>Reset your password</h1>
      <p className="muted">Enter your email and we’ll send a reset link if there’s an account for it.</p>
      {error && <Notice tone="error">{error}</Notice>}{notice && <Notice tone="success">{notice}</Notice>}
      <form className="form-stack" onSubmit={submit}>
        <label className="field-label">Email address<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
        <button className="button button-primary button-wide" disabled={busy}>{busy ? 'Sending…' : 'Send reset email'}</button>
      </form>
    </div>
  </div>
}

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams()
  const [token, setToken] = useState(searchParams.get('token') || '')
  const [newPassword, setNewPassword] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const { data } = await api('/auth/reset-password', { method: 'POST', auth: false, body: { token, newPassword } })
      setNotice(data.message)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  return <div className="narrow-page">
    <Link to="/login" className="back-link"><ArrowLeft size={16} /> Back to sign in</Link>
    <div className="simple-card">
      <div className="auth-card-icon"><KeyRound size={22} /></div>
      <span className="eyebrow">Account help</span><h1>Choose a new password</h1>
      {error && <Notice tone="error">{error}</Notice>}{notice && <Notice tone="success">{notice} <Link to="/login">Sign in</Link></Notice>}
      <form className="form-stack" onSubmit={submit}>
        <label className="field-label">Reset token<input value={token} onChange={(event) => setToken(event.target.value)} required /></label>
        <label className="field-label">New password<input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength="8" required /></label>
        <button className="button button-primary button-wide" disabled={busy}>{busy ? 'Updating…' : 'Update password'}</button>
      </form>
    </div>
  </div>
}
