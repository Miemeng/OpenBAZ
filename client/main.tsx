// 客户端入口：只负责挂载，**不写任何战斗规则**

// 刻意**不用 `React.StrictMode`**：本项目的引擎调用都发生在事件处理与受控 state 里（不靠 effect），
// StrictMode 的"开发期双调用"只会让将来的对局 / 回放调试更难判断来源；等真正引入 effect 驱动的逻辑
// 再重新评估（那时若开了，记得"引擎只跑一次"这件事要在事件里做，而不是 effect 里）。
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('找不到挂载点 #root（见 client/index.html）')
}

createRoot(container).render(<App />)
