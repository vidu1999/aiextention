// Service worker: opens the side panel, creates right-click menus and hands
// selected text / "teach this page" requests to the side panel via storage.

const MENU_SELECTION = 'page-tutor-selection';
const MENU_PAGE = 'page-tutor-teach-page';

chrome.runtime.onInstalled.addListener(() => {
  // Clicking the toolbar icon opens the side panel (right side of the browser).
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_SELECTION,
      title: 'Ask Page Tutor about "%s"',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: MENU_PAGE,
      title: 'Teach me this page',
      contexts: ['page'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.windowId === undefined) return;

  const pending =
    info.menuItemId === MENU_SELECTION
      ? { type: 'selection', text: info.selectionText || '' }
      : { type: 'page' };

  // Open first: sidePanel.open() needs the user gesture from the menu click.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
  chrome.storage.session.set({ pending: { ...pending, createdAt: Date.now() } }).catch(console.error);
});
