import { BrowserRouter, Routes, Route } from 'react-router';
import AppLayout from './layout';
import WordPage from './pages/WordPage';
import HomePage from './pages/HomePage';
import NotesPage from './pages/NotesPage';
import PhonemesPage from './pages/PhonemesPage';
import PhonemePage from './pages/PhonemePage';
import NoteDetailPage from './pages/NoteDetailPage';
import StatsPage from './pages/StatsPage';
import SettingsPage from './pages/SettingsPage';
import ReviewPage from './pages/ReviewPage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/word/:text" element={<WordPage />} />
          <Route path="/phonemes" element={<PhonemesPage />} />
          {/* IPA 符号编码在路径里；:ipa 拿到的是解过一层的原符号 */}
          <Route path="/phoneme/:ipa" element={<PhonemePage />} />
          <Route path="/notes" element={<NotesPage />} />
          <Route path="/notes/:id" element={<NoteDetailPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/stats" element={<StatsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
