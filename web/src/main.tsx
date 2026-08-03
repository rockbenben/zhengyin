import { createRoot } from 'react-dom/client';
import 'antd/dist/reset.css';
import './styles.css';
import App from './App';
import { applyPalette, paletteFor } from './theme';
import { isDarkPaper, loadHue, loadPaper } from './lib/ink';

// 在第一次渲染**之前**就把调色板写进 CSS variables。
// 放进组件的 useEffect 里的话，首屏那一帧 var(--paper) / var(--font-body) 都还没定义，
// body 的背景和字体会短暂失效——看得见的一次白闪。
// 墨色也在这一帧就定下来，否则换过墨的人每次刷新都会先闪一下默认的群青。
applyPalette(paletteFor(
  isDarkPaper(loadPaper(), window.matchMedia('(prefers-color-scheme: dark)').matches),
  loadHue(),
));

createRoot(document.getElementById('root')!).render(<App />);
