import { useState } from 'react'
import { BrowserRouter, Link, NavLink, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { ArrowRight, LogOut, Menu, UserRound } from 'lucide-react'
import { AuthProvider } from './auth'
import { Loading, Notice, PageHeading } from './components'
import { AdminPage, CartPage, ProfilePage, WalletPage } from './pages/AccountPages'
import { VendorPage } from './pages/VendorPage'
import { AuthPage, ForgotPasswordPage, ResetPasswordPage, VerifyEmailPage } from './pages/AuthPages'
import { ProductDetails, StoreDetails, Storefront } from './pages/Storefront'
import { useAuth } from './useAuth'
import './App.css'

const currentYear = new Date().getFullYear()

function Header() {
  const { user, logout } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [error, setError] = useState('')

  async function signOut() {
    setError('')
    try {
      await logout()
      navigate('/')
      setMenuOpen(false)
    } catch (logoutError) {
      setError(logoutError.message)
    }
  }

  return <>
    <header className="site-header">
      <div className="header-inner">
        <Link to="/" className="brand" onClick={() => setMenuOpen(false)}><span className="brand-mark">k</span><span>kobo<span className="brand-accent">market</span></span></Link>
        <nav className={`main-nav ${menuOpen ? 'nav-open' : ''}`} aria-label="Main navigation">
          <NavLink to="/" end onClick={() => setMenuOpen(false)}>Discover</NavLink>
          <NavLink to="/cart" onClick={() => setMenuOpen(false)}>Your bag</NavLink>
          <NavLink to="/wallet" onClick={() => setMenuOpen(false)}>Wallet</NavLink>
          <NavLink to="/vendor" onClick={() => setMenuOpen(false)}>Sell with us</NavLink>
          {user?.roles?.includes('admin') && <NavLink to="/admin" onClick={() => setMenuOpen(false)}>Admin</NavLink>}
        </nav>
        <div className="header-actions">
          {user ? <>
            <Link to="/profile" className="profile-link" title="Your profile"><UserRound size={17} /><span>{user.fullName?.split(' ')[0] || 'Account'}</span></Link>
            <button type="button" className="button button-dark button-small" onClick={signOut}><LogOut size={15} /> Sign out</button>
          </> : <>
            <Link className="login-link" to="/login" state={{ from: location.pathname }}>Sign in</Link>
            <Link className="button button-primary button-small" to="/register">Join KoboMarket <ArrowRight size={15} /></Link>
          </>}
        </div>
        <button className="mobile-menu icon-button" onClick={() => setMenuOpen((open) => !open)} aria-label="Toggle navigation"><Menu size={20} /></button>
      </div>
    </header>
    {error && <div className="header-error"><Notice tone="error">{error}</Notice></div>}
  </>
}

function Footer() {
  return <footer className="site-footer">
    <div className="footer-main">
      <div className="footer-brand"><Link to="/" className="brand brand-light"><span className="brand-mark">k</span><span>kobo<span className="brand-accent">market</span></span></Link><p>Small shops. Good finds.<br />A marketplace made for everyone.</p></div>
      <div><span className="footer-label">Explore</span><Link to="/">Shop all</Link><Link to="/vendor">Open a store</Link></div>
      <div><span className="footer-label">Your account</span><Link to="/profile">Profile</Link><Link to="/wallet">Wallet</Link><Link to="/cart">Your bag</Link></div>
      <div className="footer-signoff"><span>Made with care,</span><strong>right here in Nigeria.</strong><span className="footer-flower">✳</span></div>
    </div>
    <div className="footer-bottom"><span>© {currentYear} KoboMarket</span><span>Thoughtfully local.</span></div>
  </footer>
}

function MarketLayout() {
  const { loading, authError } = useAuth()
  if (loading) return <Loading label="Getting your market ready…" />
  return <><Header /><main className="main-content">{authError && <Notice tone="warning">We couldn’t restore your session: {authError}</Notice>}<Outlet /></main><Footer /></>
}

function RequireAuth() {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) return <Loading />
  if (!user) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />
  return <Outlet />
}

function RequireAdmin() {
  const { user } = useAuth()
  if (user?.roles?.includes('admin')) return <AdminPage />
  return <div className="content-wrap narrow-content account-page">
    <PageHeading eyebrow="Restricted area" title="Admin access required" description="Sign in with an authorized admin account to open the marketplace dashboard." />
    <Notice tone="warning">If this is your project, an operator can promote your existing account with the backend’s <code>create-admin</code> setup command. Admin access cannot be granted from the public website.</Notice>
    <Link to="/" className="button button-outline">Return to the marketplace</Link>
  </div>
}

function AppRoutes() {
  return <Routes>
    <Route element={<MarketLayout />}>
      <Route index element={<Storefront />} />
      <Route path="products/:slug" element={<ProductDetails />} />
      <Route path="stores/:id" element={<StoreDetails />} />
      <Route path="login" element={<AuthPage />} />
      <Route path="register" element={<AuthPage mode="register" />} />
      <Route path="verify-email" element={<VerifyEmailPage />} />
      <Route path="forgot-password" element={<ForgotPasswordPage />} />
      <Route path="reset-password" element={<ResetPasswordPage />} />
      <Route element={<RequireAuth />}>
        <Route path="cart" element={<CartPage />} />
        <Route path="wallet" element={<WalletPage />} />
        <Route path="profile" element={<ProfilePage />} />
        <Route path="vendor" element={<VendorPage />} />
        <Route path="admin" element={<RequireAdmin />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Route>
  </Routes>
}

export default function App() {
  return <BrowserRouter>
    <AuthProvider><AppRoutes /></AuthProvider>
  </BrowserRouter>
}
