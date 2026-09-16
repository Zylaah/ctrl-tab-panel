// ==UserScript==
// @name        ctrl-tab-panel
// @description Runtime finish for Zen Browser PR #12397.
// @include     main
// ==/UserScript==

(() => {
  "use strict";

  const CONTROLLER_KEY = "__zenCtrlTabPanelMod";
  const PANEL_ID = "zen-ctrl-tab-panel";
  const CARDS_ID = "zen-ctrl-tab-panel-cards";
  const CARD_SELECTOR = ".zen-ctrl-tab-panel-card";
  const PREFS = {
    enabled: "zen.tabs.ctrl-tab-panel.enabled",
    sortByRecentlyUsed: "zen.tabs.ctrl-tab-panel.sort-by-recent",
  };

  if (window[CONTROLLER_KEY]) {
    window[CONTROLLER_KEY].destroy();
  }

  const getBoolPref = (pref, fallback) => {
    try {
      return Services.prefs.getBoolPref(pref, fallback);
    } catch (error) {
      return fallback;
    }
  };

  const setDefaultBoolPref = (pref, value) => {
    try {
      Services.prefs.getDefaultBranch("").setBoolPref(pref, value);
    } catch (error) {}
  };

  class ZenCtrlTabPanelMod {
    static CARD_WIDTH = 250;
    static CARD_HEIGHT = 220;
    static PANEL_PADDING = 16;
    static PANEL_HEIGHT =
      ZenCtrlTabPanelMod.CARD_HEIGHT + ZenCtrlTabPanelMod.PANEL_PADDING * 2;

    #isOpen = false;
    #currentIndex = 0;
    #tabList = [];
    #thumbnailCache = new Map();
    #actualVisibleCards = undefined;
    #openGeneration = 0;
    #originalCtrlTabOpen = null;

    constructor(win) {
      this.window = win;
      this.document = win.document;
      this.onKeyDown = this.#handleKeyDown.bind(this);
      this.onKeyUp = this.#handleKeyUp.bind(this);
      this.onBlur = this.#handleBlur.bind(this);
      this.onTabClose = this.#handleTabClose.bind(this);
    }

    init() {
      setDefaultBoolPref(PREFS.enabled, true);
      setDefaultBoolPref(PREFS.sortByRecentlyUsed, false);
      this.#installPanel();
      this.#patchFirefoxCtrlTab();
      this.window.addEventListener("keydown", this.onKeyDown, true);
      this.window.addEventListener("keyup", this.onKeyUp, true);
      this.window.addEventListener("blur", this.onBlur);
      this.window.addEventListener("TabClose", this.onTabClose);
      this.window.addEventListener("unload", () => this.destroy(), { once: true });
    }

    get panel() {
      return this.document.getElementById(PANEL_ID);
    }

    get cardsContainer() {
      return this.document.getElementById(CARDS_ID);
    }

    #createXULElement(name) {
      if (this.document.createXULElement) {
        return this.document.createXULElement(name);
      }
      return this.document.createElementNS(
        "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul",
        name
      );
    }

    #installPanel() {
      if (this.panel) {
        return;
      }

      const panel = this.#createXULElement("panel");
      panel.id = PANEL_ID;
      panel.setAttribute("role", "group");
      panel.setAttribute("type", "arrow");
      panel.setAttribute("hidepopovertail", "true");
      panel.setAttribute("noautofocus", "true");
      panel.setAttribute("consumeoutsideclicks", "true");
      panel.setAttribute("animate", "false");
      panel.setAttribute("nonnativepopover", "true");

      const multiview = this.#createXULElement("panelmultiview");
      multiview.id = "zen-ctrl-tab-panel-multiview";
      multiview.setAttribute("mainViewId", "zen-ctrl-tab-panel-view");

      const view = this.#createXULElement("panelview");
      view.id = "zen-ctrl-tab-panel-view";
      view.setAttribute("class", "cui-widget-panelview");
      view.setAttribute("mainview-with-header", "true");

      const cards = this.#createXULElement("hbox");
      cards.id = CARDS_ID;
      cards.setAttribute("class", "zen-ctrl-tab-panel-cards");
      cards.setAttribute("role", "listbox");
      cards.setAttribute("aria-label", "Ctrl+Tab tabs");

      view.appendChild(cards);
      multiview.appendChild(view);
      panel.appendChild(multiview);

      const popupSet =
        this.document.getElementById("mainPopupSet") ||
        this.document.getElementById("browserPopupSet") ||
        this.document.documentElement;
      popupSet.appendChild(panel);
    }

    #patchFirefoxCtrlTab() {
      if (!this.window.ctrlTab || this.#originalCtrlTabOpen) {
        return;
      }

      this.#originalCtrlTabOpen = this.window.ctrlTab.open;
      const controller = this;
      this.window.ctrlTab.open = function ctrlTabOpenShim(...args) {
        if (getBoolPref(PREFS.enabled, true)) {
          return undefined;
        }
        return controller.#originalCtrlTabOpen.apply(this, args);
      };
    }

    #handleKeyDown(event) {
      if (!getBoolPref(PREFS.enabled, true)) {
        return;
      }

      if (this.#isOpen && event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.close(false);
        return;
      }

      if (!event.ctrlKey || event.key !== "Tab") {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();

      if (!this.#isOpen) {
        this.open(event.shiftKey);
      } else if (event.shiftKey) {
        this.navigateBackward();
      } else {
        this.navigateForward();
      }
    }

    #handleKeyUp(event) {
      if (this.#isOpen && event.key === "Control") {
        this.close();
      }
    }

    #handleBlur() {
      if (this.#isOpen) {
        this.close(false);
      }
    }

    #handleTabClose(event) {
      const tabId = event.target.linkedPanel;
      URL.revokeObjectURL(this.#thumbnailCache.get(tabId));
      this.#thumbnailCache.delete(tabId);
    }

    #getMaxCards() {
      const screenWidth = this.window.screen.width;
      const getPanelWidth = cards =>
        ZenCtrlTabPanelMod.CARD_WIDTH * cards +
        ZenCtrlTabPanelMod.PANEL_PADDING * 2;

      if (screenWidth < getPanelWidth(4)) {
        return 3;
      }
      if (screenWidth < getPanelWidth(5)) {
        return 4;
      }
      return 5;
    }

    async open(shiftKey = false) {
      if (this.#isOpen) {
        return;
      }

      const sortByRecentlyUsed = getBoolPref(PREFS.sortByRecentlyUsed, false);
      this.#tabList = Array.from(gBrowser.tabs).filter(tab => {
        if (tab.closing || !tab.visible || tab.hasAttribute("busy")) {
          return false;
        }
        if (sortByRecentlyUsed && tab.hasAttribute("pending")) {
          return false;
        }
        return true;
      });

      if (sortByRecentlyUsed) {
        this.#tabList.sort((tab1, tab2) => tab2.lastAccessed - tab1.lastAccessed);
      }

      if (this.#tabList.length <= 1) {
        return;
      }

      const currentId = gBrowser.selectedTab.linkedPanel;
      URL.revokeObjectURL(this.#thumbnailCache.get(currentId));
      this.#thumbnailCache.delete(currentId);

      const initialCardIndex = sortByRecentlyUsed
        ? 0
        : this.#tabList.indexOf(gBrowser.selectedTab);

      if (shiftKey) {
        this.#currentIndex =
          (initialCardIndex - 1 + this.#tabList.length) % this.#tabList.length;
      } else {
        this.#currentIndex = (initialCardIndex + 1) % this.#tabList.length;
      }

      this.#actualVisibleCards = Math.min(this.#tabList.length, this.#getMaxCards());
      this.#isOpen = true;
      const openGeneration = ++this.#openGeneration;

      const tabboxRect = gBrowser.tabbox.getBoundingClientRect();
      const tabBoxAspectRatio = tabboxRect.width / tabboxRect.height || 1;
      const thumbnailWidth = Math.round(
        Math.min(Math.max(tabBoxAspectRatio * 500, 300), 700)
      );
      const thumbnailHeight = Math.round(thumbnailWidth / tabBoxAspectRatio);

      this.#createTabCards();
      this.#captureVisibleThumbnails(
        openGeneration,
        thumbnailWidth,
        thumbnailHeight
      );

      const scrollPosition =
        this.#getPageStartIndex(this.#currentIndex) * ZenCtrlTabPanelMod.CARD_WIDTH;
      const panelWidth =
        ZenCtrlTabPanelMod.CARD_WIDTH * this.#actualVisibleCards +
        ZenCtrlTabPanelMod.PANEL_PADDING * 2;
      const centerX = Math.max(0, (this.window.innerWidth - panelWidth) / 2);
      const centerY =
        (this.window.innerHeight - ZenCtrlTabPanelMod.PANEL_HEIGHT) / 2;

      this.panel.addEventListener(
        "popupshowing",
        () => {
          this.cardsContainer.scrollLeft = scrollPosition;
        },
        { once: true }
      );

      this.panel.addEventListener(
        "popuphidden",
        () => {
          this.close(false);
        },
        { once: true }
      );

      PanelMultiView.openPopup(this.panel, this.document.documentElement, {
        position: "overlap",
        triggerEvent: null,
        x: centerX,
        y: centerY,
      });
    }

    close(switchTab = true) {
      if (!this.#isOpen) {
        return;
      }

      const selectedTab = this.#tabList[this.#currentIndex];
      if (
        switchTab &&
        selectedTab &&
        !selectedTab.closing &&
        selectedTab !== gBrowser.selectedTab
      ) {
        gBrowser.selectedTab = selectedTab;
      }

      this.#isOpen = false;
      this.#openGeneration++;
      this.#currentIndex = 0;
      this.#tabList = [];
      this.#actualVisibleCards = undefined;
      this.panel?.hidePopup();
    }

    async #captureVisibleThumbnails(openGeneration, thumbnailWidth, thumbnailHeight) {
      const visibleStart = this.#getPageStartIndex(this.#currentIndex);
      const visibleEnd = visibleStart + this.#actualVisibleCards;
      const visibleTabs = this.#tabList.slice(visibleStart, visibleEnd);
      const remainingTabs = this.#tabList.filter(tab => !visibleTabs.includes(tab));

      for (const tab of [...visibleTabs, ...remainingTabs]) {
        try {
          await this.#captureThumbnail(tab, thumbnailWidth, thumbnailHeight);
        } catch (error) {}

        if (!this.#isOpen || openGeneration !== this.#openGeneration) {
          return;
        }

        this.#updateCardThumbnail(tab);
      }
    }

    async #captureThumbnail(tab, thumbnailWidth, thumbnailHeight) {
      const browser = tab.linkedBrowser;
      const tabId = tab.linkedPanel;

      if (
        tab.hasAttribute("pending") ||
        tab.closing ||
        this.#thumbnailCache.has(tabId) ||
        !browser ||
        !this.window.PageThumbs
      ) {
        return;
      }

      const canvas = this.document.createElement("canvas");
      canvas.width = thumbnailWidth;
      canvas.height = thumbnailHeight;

      await this.window.PageThumbs.captureToCanvas(browser, canvas, {
        fullViewport: true,
      });

      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      if (blob) {
        this.#thumbnailCache.set(tabId, URL.createObjectURL(blob));
      }
    }

    #createTabCards() {
      if (!this.cardsContainer) {
        return;
      }

      const defaultFavicon = PlacesUtils.favicons.defaultFavicon.spec;
      const newTabFavicon = "chrome://browser/skin/zen-icons/new-tab-image.svg";

      this.cardsContainer.replaceChildren();
      this.cardsContainer.style.width = `${
        ZenCtrlTabPanelMod.CARD_WIDTH * this.#actualVisibleCards
      }px`;

      this.#tabList.forEach((tab, index) => {
        const card = this.document.createElement("div");
        card.className = "zen-ctrl-tab-panel-card";
        card.setAttribute("role", "option");
        card.setAttribute("aria-selected", index === this.#currentIndex ? "true" : "false");
        card.setAttribute("title", tab.label);
        card.dataset.tabId = tab.linkedPanel;

        const thumbnailContainer = this.document.createElement("div");
        thumbnailContainer.className = "zen-ctrl-tab-panel-thumbnail";

        const thumbnail = tab.hasAttribute("pending")
          ? null
          : this.#thumbnailCache.get(tab.linkedPanel);

        if (thumbnail) {
          const img = this.document.createElement("img");
          img.src = thumbnail;
          thumbnailContainer.appendChild(img);
        } else {
          card.classList.add("zen-ctrl-tab-panel-no-thumbnail");
        }

        card.appendChild(thumbnailContainer);

        const infoContainer = this.document.createElement("div");
        infoContainer.className = "zen-ctrl-tab-panel-info";

        const favicon = this.document.createElement("img");
        favicon.className = "zen-ctrl-tab-panel-favicon";

        let iconSrc = gBrowser.getIcon(tab) || defaultFavicon;
        if (iconSrc.startsWith("chrome://branding/content/")) {
          iconSrc = newTabFavicon;
        }

        favicon.src = iconSrc;
        infoContainer.appendChild(favicon);

        const title = this.document.createElement("div");
        title.className = "zen-ctrl-tab-panel-title";
        title.textContent = tab.label;

        infoContainer.appendChild(title);
        card.appendChild(infoContainer);

        if (tab.hasAttribute("pending")) {
          card.classList.add("zen-ctrl-tab-panel-pending");
        }

        if (index === this.#currentIndex) {
          card.classList.add("zen-ctrl-tab-panel-selected");
        }

        card.addEventListener("click", () => {
          this.#currentIndex = index;
          this.close();
        });

        card.addEventListener("mouseenter", () => {
          if (this.#currentIndex === index) {
            return;
          }
          const previousIndex = this.#currentIndex;
          this.#currentIndex = index;
          this.#updateSelection(previousIndex, { scroll: false });
        });

        this.cardsContainer.appendChild(card);
      });
    }

    #updateCardThumbnail(tab) {
      const card = this.cardsContainer?.querySelector(
        `${CARD_SELECTOR}[data-tab-id="${CSS.escape(tab.linkedPanel)}"]`
      );
      const thumbnailContainer = card?.querySelector(".zen-ctrl-tab-panel-thumbnail");
      const thumbnail = this.#thumbnailCache.get(tab.linkedPanel);

      if (!card || !thumbnailContainer || !thumbnail) {
        return;
      }

      thumbnailContainer.replaceChildren();
      const img = this.document.createElement("img");
      img.src = thumbnail;
      thumbnailContainer.appendChild(img);
      card.classList.remove("zen-ctrl-tab-panel-no-thumbnail");
    }

    #updateSelection(previousIndex, options = {}) {
      if (!this.cardsContainer?.children.length) {
        return;
      }

      const previousCard = this.cardsContainer.children[previousIndex];
      const currentCard = this.cardsContainer.children[this.#currentIndex];
      previousCard?.classList.remove("zen-ctrl-tab-panel-selected");
      previousCard?.setAttribute("aria-selected", "false");
      currentCard?.classList.add("zen-ctrl-tab-panel-selected");
      currentCard?.setAttribute("aria-selected", "true");

      if (options.scroll === false) {
        return;
      }

      const scrollPosition =
        this.#getPageStartIndex(this.#currentIndex) * ZenCtrlTabPanelMod.CARD_WIDTH;

      this.cardsContainer.scrollTo({
        left: scrollPosition,
        behavior: "smooth",
      });
    }

    #getPageStartIndex(currentCardIndex) {
      const totalTabs = this.#tabList.length;
      const maxVisible = this.#actualVisibleCards;

      if (totalTabs <= maxVisible) {
        return 0;
      }

      const pageStartIndex = Math.floor(currentCardIndex / maxVisible) * maxVisible;
      if (pageStartIndex + maxVisible > totalTabs) {
        return totalTabs - maxVisible;
      }

      return pageStartIndex;
    }

    navigateForward() {
      const previousIndex = this.#currentIndex;
      this.#currentIndex = (this.#currentIndex + 1) % this.#tabList.length;
      this.#updateSelection(previousIndex);
    }

    navigateBackward() {
      const previousIndex = this.#currentIndex;
      this.#currentIndex =
        (this.#currentIndex - 1 + this.#tabList.length) % this.#tabList.length;
      this.#updateSelection(previousIndex);
    }

    destroy() {
      this.window.removeEventListener("keydown", this.onKeyDown, true);
      this.window.removeEventListener("keyup", this.onKeyUp, true);
      this.window.removeEventListener("blur", this.onBlur);
      this.window.removeEventListener("TabClose", this.onTabClose);

      if (this.window.ctrlTab && this.#originalCtrlTabOpen) {
        this.window.ctrlTab.open = this.#originalCtrlTabOpen;
      }

      for (const thumbnail of this.#thumbnailCache.values()) {
        URL.revokeObjectURL(thumbnail);
      }
      this.#thumbnailCache.clear();
      this.panel?.remove();
      delete this.window.gZenCtrlTabPanel;
      delete this.window[CONTROLLER_KEY];
    }
  }

  const controller = new ZenCtrlTabPanelMod(window);
  window[CONTROLLER_KEY] = controller;
  window.gZenCtrlTabPanel = controller;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => controller.init(), { once: true });
  } else {
    controller.init();
  }
})();
