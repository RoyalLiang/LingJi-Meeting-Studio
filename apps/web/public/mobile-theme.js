// Match the saved theme before the first paint, while the React bundle is loading.
try {
  const theme = localStorage.getItem('meeting-theme');
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#1a1a1c' : '#f4f4f5';
  }
} catch {
  // The document's system color scheme remains available when storage is blocked.
}
