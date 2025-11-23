// ABOUTME: Main layout component providing navigation bar and routing container for admin UI
// ABOUTME: Uses React Router Outlet to render child pages (Search, Reserve, Assign, Revoke, Reserved Words)
import { Link, Outlet, useLocation } from 'react-router-dom'

export default function Layout() {
  const location = useLocation()

  const isActive = (path: string) => location.pathname === path

  const navLinkClass = (path: string) =>
    `px-3 py-2 rounded-md text-sm font-medium ${
      isActive(path)
        ? 'bg-blue-700 text-white'
        : 'text-white hover:bg-blue-600'
    }`

  return (
    <div className="min-h-screen bg-gray-100">
      <nav className="bg-blue-500 shadow-lg">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center space-x-4">
              <a
                href="https://admin.divine.video"
                className="text-white hover:text-blue-200 transition-colors flex items-center"
                title="Back to Divine Services Dashboard"
              >
                <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                </svg>
                Dashboard
              </a>
              <a
                href="https://faro.admin.divine.video"
                className="text-white hover:text-blue-200 transition-colors flex items-center"
                title="Nostr Content Reports"
                target="_blank"
                rel="noopener noreferrer"
              >
                <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Content Reports
              </a>
              <a
                href="https://rabblelabs.zendesk.com/"
                className="text-white hover:text-blue-200 transition-colors flex items-center"
                title="Zendesk Support"
                target="_blank"
                rel="noopener noreferrer"
              >
                <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 5.636l-3.536 3.536m0 5.656l3.536 3.536M9.172 9.172L5.636 5.636m3.536 9.192l-3.536 3.536M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-5 0a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
                Zendesk
              </a>
              <a
                href="https://review.admin.divine.video/admin"
                className="text-white hover:text-blue-200 transition-colors flex items-center"
                title="Video Review - Automatic Labels"
                target="_blank"
                rel="noopener noreferrer"
              >
                <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                Video Review
              </a>
              <h1 className="text-xl font-bold text-white border-l border-blue-400 pl-4">
                Name Server Admin
              </h1>
            </div>
            <div className="flex space-x-4">
              <Link to="/" className={navLinkClass('/')}>
                Search
              </Link>
              <Link to="/reserve" className={navLinkClass('/reserve')}>
                Reserve
              </Link>
              <Link to="/assign" className={navLinkClass('/assign')}>
                Assign
              </Link>
              <Link to="/revoke" className={navLinkClass('/revoke')}>
                Revoke
              </Link>
              <Link to="/reserved-words" className={navLinkClass('/reserved-words')}>
                Reserved Words
              </Link>
            </div>
          </div>
        </div>
      </nav>

      <main className="container mx-auto px-4 py-8">
        <Outlet />
      </main>
    </div>
  )
}
