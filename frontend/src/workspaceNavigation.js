export function navigateWorkspace(workspace) {
  const url = new URL(window.location.href);
  url.searchParams.set('workspace', workspace);
  window.history.pushState({}, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
