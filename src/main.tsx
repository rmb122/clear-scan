import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App'

const updateServiceWorker = registerSW({
  immediate: true,
  onNeedRefresh() {
    if (window.confirm('清晰扫描有新版本，是否立即更新？')) {
      void updateServiceWorker(true)
    }
  },
  onRegisterError(error) {
    console.error('PWA 离线服务注册失败', error)
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
