// Apollo "next" preview layout -- entry point for web/next.html (a separate
// Vite build page, see web/vite.config.js's multi-page `rollupOptions.input`
// and src/webServer.js's `/next` route). Mirrors main.jsx's own entry point;
// this is a second page sharing the same state layer, not a route inside the
// classic dashboard's bundle.

import { render } from 'preact';
import NextApp from './NextApp.jsx';

render(<NextApp />, document.getElementById('app'));
