import { createRoot } from 'react-dom/client';
import { BookmarkNavPage } from './BookmarkNavPage';
import { ErrorBoundary } from '../sidepanel/ErrorBoundary';
import './bookmark-nav.css';

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <BookmarkNavPage />
  </ErrorBoundary>,
);
