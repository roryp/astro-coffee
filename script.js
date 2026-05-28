(function initTheme() {
  const STORAGE_KEY = 'theme-preference';
  const htmlElement = document.documentElement;
  const toggleButton = document.getElementById('theme-toggle');

  // Get stored preference or system preference
  function getThemePreference() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return stored;
    }
    
    // Check system preference
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  }

  // Apply theme to document
  function applyTheme(theme) {
    if (theme === 'dark') {
      htmlElement.classList.add('dark-mode');
      htmlElement.classList.remove('light-mode');
    } else {
      htmlElement.classList.add('light-mode');
      htmlElement.classList.remove('dark-mode');
    }
    updateButtonLabel(theme);
  }

  // Update button text to show which mode you'll switch TO
  function updateButtonLabel(currentTheme) {
    const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
    const emoji = nextTheme === 'dark' ? '🌙' : '☀️';
    const label = nextTheme === 'dark' ? 'Dark mode' : 'Light mode';
    
    toggleButton.textContent = `${emoji} ${label}`;
    toggleButton.setAttribute('aria-label', `Switch to ${label}`);
  }

  // Toggle theme
  function toggleTheme() {
    const currentTheme = getThemePreference();
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    
    localStorage.setItem(STORAGE_KEY, newTheme);
    applyTheme(newTheme);
  }

  // Initialize on page load
  const initialTheme = getThemePreference();
  applyTheme(initialTheme);

  // Listen for system theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    const stored = localStorage.getItem(STORAGE_KEY);
    // Only apply system change if user hasn't set a manual preference
    if (!stored) {
      applyTheme(e.matches ? 'dark' : 'light');
    }
  });

  // Attach click handler
  toggleButton.addEventListener('click', toggleTheme);
})();
