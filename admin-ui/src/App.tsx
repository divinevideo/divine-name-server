// ABOUTME: Root application component configuring React Router for the admin UI
// ABOUTME: Sets up nested routes with Layout wrapper and all admin pages (Dashboard, Reserve, Assign, Revoke, Reserved Words)
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Reserve from './pages/Reserve'
import Assign from './pages/Assign'
import Revoke from './pages/Revoke'
import ReservedWords from './pages/ReservedWords'
import UsernameDetail from './pages/UsernameDetail'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="username/:name" element={<UsernameDetail />} />
          <Route path="reserve" element={<Reserve />} />
          <Route path="assign" element={<Assign />} />
          <Route path="revoke" element={<Revoke />} />
          <Route path="reserved-words" element={<ReservedWords />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
