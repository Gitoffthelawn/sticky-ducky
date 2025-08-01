'use strict';

let settings = {
    // This a reference for the settings structure. The values will be updated.
    isDevelopment: false,
    behavior: 'scroll',
    whitelist: {
        type: 'none',  // ['none', 'page', 'selectors']
        selectors: []  // optional, if the type is 'selectors'
    },
    transitionDuration: 0.2,  // Duration of show/hide animation
    typesToShow: ['sidebar', 'splash', 'hidden']  // Hidden is here for caution - dimensions of a hidden element are unknown, and it cannot be classified
};

function internalLog(logger, ...args) {
    if (settings.isDevelopment) {
        logger('Sticky Ducky: ', ...args);
    }
}

const log = (...args) => internalLog(console.log, ...args);
const warn = (...args) => internalLog(console.warn, ...args);
const error = (...args) => internalLog(console.error, ...args);

log('Content script starting...');
log('_ available:', typeof _ !== 'undefined');
log('CSSWhat available:', typeof CSSWhat !== 'undefined');


let exploration = {
    limit: 2,  // Limit for exploration on shorter scroll distance
    lastScrollY: 0,  // Keeps track of the scroll position during the last exploration
    // Storing the DOM nodes rather than stylesheet objects reduces memory consumption.
    internalSheets: [],  // Internal top level stylesheets along with metadata
    externalSheets: {},  // A map where href is key and metadata is value
    sheetNodeSet: new Set(),  // Owner nodes of all top level stylesheets
    selectors: {
        fixed: ['*[style*="fixed" i]'],
        sticky: ['*[style*="sticky" i]'],
        pseudoElements: []
    }
};
let lastKnownScrollY = undefined;
let stickyFixer = null;
let scrollListener = _.debounce(_.throttle(ev => doAll(false, false, ev), 300), 50);  // Debounce delay makes it run after the page scroll listeners


// Helper function to send messages to service worker with retry logic
async function sendMessageToServiceWorker(message, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            log('Sending message to service worker (attempt', i + 1, '):', message.name);
            const response = await chrome.runtime.sendMessage(message);
            log('Service worker response received:', response);
            return response;
        } catch (err) {
            warn('Message send failed (attempt', i + 1, '):', err.message);
            
            if (err.message.includes('Could not establish connection') || 
            err.message.includes('Receiving end does not exist')) {
                
                if (i < retries - 1) {
                    // Wait a bit before retrying to let service worker wake up
                    log('Waiting 200ms before retry...');
                    await new Promise(resolve => setTimeout(resolve, 200));
                    continue;
                } else {
                    error('Service worker not responding after', retries, 'attempts');
                    throw new Error('Service worker not responding');
                }
            } else {
                // For other errors, don't retry
                throw err;
            }
        }
    }
}

// Centralized function to refresh settings from service worker
async function refreshSettings(context = 'unknown') {
    try {
        log('Refreshing settings from context:', context);
        const locationData = _.omit(window.location, _.isFunction);
        const response = await sendMessageToServiceWorker({
            name: 'getSettings',
            message: {location: locationData}
        });
        
        log('Settings response from', context + ':', response);
        if (response && response.name === 'settings') {
            log('Processing settings from', context);
            onNewSettings(response.message);
            return true;
        } else {
            warn('Invalid settings response from', context);
            return false;
        }
    } catch (err) {
        error('Failed to refresh settings from', context + ':', err);
        return false;
    }
}

class StickyFixer {
    constructor(stylesheet, state, getNewState, makeSelectorForHidden, hiddenStyle) {
        this.stylesheet = stylesheet;
        this.state = state; // hide, show, showFooters
        this.getNewState = getNewState;
        this.makeSelectorForHidden = makeSelectorForHidden;
        this.hiddenStyle = hiddenStyle;
        this.ruleCache = {};
    }

    onChange(scrollInfo, forceUpdate) {
        let state = this.state;
        if (scrollInfo) {
            let input = {
                scrollY: scrollInfo.scrollY,
                oldState: this.state,
                isOnTop: scrollInfo.scrollY / window.innerHeight < 0.1,
                isOnBottom: (scrollInfo.scrollHeight - scrollInfo.scrollY) / window.innerHeight < 1.3  // close to 1/3 of the last screen
            };
            let defaultState = input.isOnTop && 'show' || input.isOnBottom && 'showFooters' || 'hide';
            state = this.getNewState(defaultState, input);
        }
        if (forceUpdate || state !== this.state) {
            this.updateStylesheet(this.getRules(state));
            this.state = state;
        }
    }

    getRules(state) {
        // Opacity is the best way to fix the headers. Removing the fixed position breaks some layouts.
        // Select and hide them by the sticky-ducky-* attributes.
        // For better precision it's better to have `:moz-any(${exploration.selectors.sticky.join('')})`
        // instead of '*[sticky-ducky-position="sticky"]' but :moz-any and :is don't support compound selectors.
        // The :not(#sticky-ducky-boost-specificity) increases the specificity of the selectors.
        const rules = [];
        const typesToShow = state === 'showFooters' ? settings.typesToShow.concat('footer') : settings.typesToShow;
        const notWhitelistedSelector = settings.whitelist.type === 'selectors' ? settings.whitelist.selectors.map(s => `:not(${s})`).join('') : '';

        const ignoreTypesToShowSelector = typesToShow.map(type => `:not([sticky-ducky-type="${type}"])`).join('');
        const hiddenSelector = `[sticky-ducky-type]:not(#sticky-ducky-boost-specificity):not(:focus-within)${notWhitelistedSelector}`;

        // Apply the fix ignoring state. Otherwise, the layout will jump on scroll when shown after scrolling up.
        // Ignore cases that have top set to a non-zero value. For example, file headers in GitHub PRs.
        // If it is set to !important, the element would look shifted.
        const stickySelector = `*[sticky-ducky-position="sticky"]:not([style*="top:"]:not([style*="top:0"], [style*="top: 0"]))${hiddenSelector}`;

        // The static position doesn't work - see tests/stickyPosition.html
        // Relative position shifts when the element has a style for top, like GitHub does.
        // Hiding them makes little sense if they aren't out of viewport.
        const stickyFixStyle = this.getCachedStyle('stickyFixStyle', {position: 'relative', top: "0"});
        rules.push(`${stickySelector} ${stickyFixStyle}`);

        const hideElsStyle = this.getCachedStyle('hideElsStyle', this.hiddenStyle);
        const showStyle = this.getCachedStyle('showStyle', {transition: `opacity ${settings.transitionDuration}s ease-in-out;`});
        if (exploration.selectors.pseudoElements.length) {
            const allSelectors = exploration.selectors.pseudoElements.map(s => `${s.selector}::${s.pseudoElement}`).join(',');
            rules.push(`${allSelectors} ${showStyle}`);
            // Hide all fixed pseudo-elements. They cannot be classified, as you can't get their bounding rect
            // So a pseudo-element that looks like a footer would still be hidden when page is scrolled to the bottom.
            if (state !== 'show') {
                const hidePseudoElsSelector = exploration.selectors.pseudoElements.map(s => `${this.makeSelectorForHidden(s.selector)}::${s.pseudoElement}`).join(',');
                rules.push(`${hidePseudoElsSelector} ${hideElsStyle}`);
            }
        }

        const fixedSelector = `*[sticky-ducky-position="fixed"]${hiddenSelector}`;
        // To keep the opacity transitions animated, the show rule is included for all states.
        rules.push(`${fixedSelector} ${showStyle}`);
        if (state !== 'show') {
            const hideFixedElsSelector = this.makeSelectorForHidden(fixedSelector);
            rules.push(`${hideFixedElsSelector}${ignoreTypesToShowSelector} ${hideElsStyle}`);
        }

        return rules;
    }

    updateStylesheet(rules) {
        log('Updating stylesheet rules', rules);
        if (!this.stylesheet || !document.contains(this.stylesheet.ownerNode)) {
            let style = document.head.appendChild(document.createElement('style'));
            this.stylesheet = style.sheet;
        }
        // TODO: compare cssText against the rule and replace only the mismatching rules
        _.map(this.stylesheet.cssRules, () => this.stylesheet.deleteRule(0));
        rules.forEach(rule => this.stylesheet.insertRule(rule, this.stylesheet.cssRules.length));
    }

    getCachedStyle(name, style) {
        if (!this.ruleCache[name]) {
            this.ruleCache[name] = makeStyle(style);
        }
        return this.ruleCache[name];
    }
}

let fixers = {
    'hover': {
        getNewState: defaultState => defaultState,
        makeSelectorForHidden: selector => selector + ':not(:hover)',
        // In case the element has animation keyframes involving opacity, set animation to none
        // Opacity in a keyframe overrides even an !important rule.
        hiddenStyle: {opacity: 0, animation: 'none'}
    },
    'scroll': {
        getNewState: (defaultState, {scrollY, oldState}) => {
            log('Scroll decision', defaultState, scrollY, lastKnownScrollY, oldState);
            return scrollY === lastKnownScrollY && oldState
                || scrollY < lastKnownScrollY && 'show'
                || defaultState
        },
        makeSelectorForHidden: selector => selector,
        hiddenStyle: {
            opacity: 0,
            // Display: none cannot be used in a transition.
            // So visibility hides a sticky, and pointer-events makes it non-interactive.
            visibility: 'hidden',
            transition: `opacity ${settings.transitionDuration}s ease-in-out, visibility 0s ${settings.transitionDuration}s`,
            animation: 'none',
            'pointer-events': 'none'
        }
    },
    'top': {
        getNewState: defaultState => defaultState,
        makeSelectorForHidden: selector => selector,
        hiddenStyle: {
            opacity: 0,
            visibility: 'hidden',
            transition: `opacity ${settings.transitionDuration}s ease-in-out, visibility 0s ${settings.transitionDuration}s`,
            animation: 'none',
            'pointer-events': 'none'
        }
    },
    'absolute': {
        getNewState: defaultState => defaultState,
        makeSelectorForHidden: selector => selector,
        hiddenStyle: {position: 'absolute'}
    }
};

function makeStyle(styles) {
    const stylesText = Object.keys(styles).map(name => `${name}: ${styles[name]} !important;`);
    return `{ ${stylesText.join('')} }`;
}

function getDocumentHeight() {
    // http://james.padolsey.com/javascript/get-document-height-cross-browser/
    const body = document.body, html = document.documentElement;
    return Math.max(
        body.scrollHeight, body.offsetHeight, body.clientHeight,
        html.scrollHeight, html.offsetHeight, html.clientHeight);
}

function measure(label, f) {
    if (!settings.isDevelopment) return f();
    const before = window.performance.now();
    const result = f();
    const after = window.performance.now();
    log(`Call to ${label} took ${after - before}ms`);
    return result;
}

function classify(el) {
    // Optimize for hidden elements
    if (window.getComputedStyle(el).display === 'none') {
        return 'hidden';
    }
    const viewportWidth = window.innerWidth,
        viewportHeight = window.innerHeight,
        rect = el.getBoundingClientRect(),
        clip = (val, low, high, max) => Math.max(0, val + Math.min(low, 0) + Math.min(max - high, 0)),
        width = clip(rect.width || el.scrollWidth, rect.left, rect.right, viewportWidth),
        height = clip(rect.height || el.scrollHeight, rect.top, rect.bottom, viewportHeight),
        isWide = width / viewportWidth > 0.35,
        isThin = height / viewportHeight < 0.25,
        isTall = height / viewportHeight > 0.5,
        isOnTop = rect.top / viewportHeight < 0.1,
        isOnBottom = rect.bottom / viewportHeight > 0.9,
        isOnSide = rect.left / viewportWidth < 0.1 || rect.right / viewportWidth > 0.9;
    const type = isWide && isThin && isOnTop && 'header'
        || isWide && isThin && isOnBottom && 'footer'
        || isWide && isTall && 'splash'
        || isTall && isOnSide && 'sidebar'
        || width === 0 && height === 0 && 'hidden'
        || 'widget';
    log(`Classified as ${type}`, el);
    return type;
}

function onNewSettings(newSettings) {
    log('onNewSettings called with:', newSettings);
    // The new settings may contain only the updated properties
    _.extend(settings, newSettings);
    log('Settings after update:', settings);
    if (document.readyState === 'loading') {
        log('Document still loading, waiting for DOMContentLoaded');
        document.addEventListener('DOMContentLoaded', activateSettings);
    } else {
        log('Document ready, activating settings immediately');
        activateSettings();
    }
}

function activateSettings() {
    log(`Activating behavior ${settings.behavior}`);
    const isActive = !!stickyFixer;  // Presence of stickyFixer indicates that the scroll listener is set
    const shouldBeActive = settings.behavior !== 'always' && settings.whitelist.type !== 'page';
    if (shouldBeActive) {
        // Detecting passive events on Firefox and setting the listener immediately is buggy. Manifest supports only browsers that have it.
        if (!isActive) {
            document.addEventListener('scroll', scrollListener, {passive: true, capture: true});
        }
        const newFixer = fixers[settings.behavior];
        stickyFixer = new StickyFixer(stickyFixer && stickyFixer.stylesheet, stickyFixer && stickyFixer.state, newFixer.getNewState, newFixer.makeSelectorForHidden, newFixer.hiddenStyle);
        doAll(true, true);
    } else if (isActive && !shouldBeActive) {
        document.removeEventListener('scroll', scrollListener);
        if (stickyFixer.stylesheet) stickyFixer.stylesheet.ownerNode.remove();
        stickyFixer = null;
    }
}

let exploreStickies = () => {
    let selectors = exploration.selectors.fixed.concat(exploration.selectors.sticky);
    let els = document.querySelectorAll(selectors.join(','));
    els.forEach(el => {
        // Attributes are less likely to interfere with the page than dataset data-*.
        let type = el.getAttribute('sticky-ducky-type')
        if (!type || type === 'hidden') {
            el.setAttribute('sticky-ducky-type', classify(el));
        }

        let position = el.getAttribute('sticky-ducky-position');
        if (!position || position === 'other') {
            // Think of a header that only gets fixed once you scroll. That's why "other" has to be checked regularly.
            el.setAttribute('sticky-ducky-position', getPosition(el));
        }
    });
    log('Explored stickies', els);
};

let getPosition = el => {
    // This handles "FiXeD !important" or "-webkit-sticky" positions
    const position = window.getComputedStyle(el).position.toLowerCase();
    return position.includes('fixed') && 'fixed'
        || position.includes('sticky') && 'sticky'
        || 'other';
};

function exploreStylesheets() {
    let anyRemoved = false;
    let explorer = new Explorer(result => onSheetExplored(result));
    // We detect dynamic updates for the internal stylesheets by comparing rules size.
    // All internal (declared with <style>) stylesheets have cssRules available.
    // Updates to external and imported stylesheets are not checked.
    exploration.internalSheets.forEach(sheetInfo => {
        let ownerNode = sheetInfo.ownerNode;
        if (!document.contains(ownerNode)) {  // The stylesheet has been removed.
            sheetInfo.removed = anyRemoved = true;
            exploration.sheetNodeSet.delete(ownerNode);
            return;
        }
        if (sheetInfo.rulesCount !== ownerNode.sheet.cssRules.length) {
            explorer.exploreStylesheet(ownerNode.sheet);
            sheetInfo.rulesCount = ownerNode.sheet.cssRules.length;
        }
    });
    if (anyRemoved) exploration.internalSheets = exploration.internalSheets.filter(sheetInfo => !sheetInfo.removed);

    // TODO: If the page uses Web Components the styles won't be in the document

    _.forEach(document.styleSheets, sheet => {
        if (sheet === stickyFixer.stylesheet ||
            !sheet.ownerNode ||
            exploration.sheetNodeSet.has(sheet.ownerNode)) return;
        exploration.sheetNodeSet.add(sheet.ownerNode);
        if (sheet.href) {
            exploration.externalSheets[sheet.href] = {status: 'unexplored'};
        } else {
            let sheetInfo = {ownerNode: sheet.ownerNode, rulesCount: sheet.cssRules.length};
            exploration.internalSheets.push(sheetInfo);
        }
        explorer.exploreStylesheet(sheet);
    });
}

function onSheetExplored(result) {
    if (result.status === 'success') {
        onNewSelectors(result.selectors);
    }
    if (result.href) {
        let sheetInfo = exploration.externalSheets[result.href];
        let newSheetInfo = null;
        if (result.status === 'fail') {
            // It can fail because of CORS
            warn('Failed to explore sheet on the content page:', result);
            if (sheetInfo && sheetInfo.status === 'unexplored') {
                newSheetInfo = {
                    status: 'awaitingServiceWorkerFetch',
                    error: result.error
                };
                sendMessageToServiceWorker({
                    name: 'exploreSheet',
                    message: {href: result.href, baseURI: result.baseURI}
                }).then(response => {
                    log('ExploreSheet response:', response);
                    if (response && response.name === 'sheetExplored') {
                        onSheetExplored(response.message);
                    }
                }).catch(err => {
                    error('Failed to explore sheet on the service worker:', err);
                    // Mark as failed so we don't keep retrying
                    exploration.externalSheets[result.href] = {
                        status: 'fail',
                        error: err.message
                    };
                });
            } else {
                 newSheetInfo = {
                    status: 'fail',
                    error: result.error
                };
            }
        } else if (result.status === 'success') {
            newSheetInfo = {
                status: 'success'
            };
        }
        exploration.externalSheets[result.href] = newSheetInfo;
    }
}

function onNewSelectors(selectorDescriptions) {
    if (selectorDescriptions.length === 0) return;
    let forceUpdate = false;
    let forceExplore = false;
    // The duplicates occur only when the rules duplicate in the website stylesheets. They are rare and not worth checking.
    selectorDescriptions.forEach(description => {
        if (description.pseudoElement) {
            forceUpdate = true;
            exploration.selectors.pseudoElements.push(description);
        } else if (description.position === 'sticky') {
            forceExplore = true;
            exploration.selectors.sticky.push(description.selector);
        } else if (description.position === 'fixed') {
            forceExplore = true;
            exploration.selectors.fixed.push(description.selector);
        }
    });
    if (!stickyFixer) return;  // Nothing left to do after recording the selectors
    if (forceExplore) exploreStickies();
    if (forceUpdate) stickyFixer.onChange(undefined, true);
}

function doAll(forceExplore, settingsChanged, ev) {
    if (!stickyFixer) {
        // This may happen if the doAll is scheduled asynchronously, and the sticky ducky got disabled. That could be done with whitelist or "always" behavior.
        return;
    }
    let forceUpdate = settingsChanged;
    let scrollInfo = {
        scrollY: window.scrollY,
        scrollHeight: getDocumentHeight(),
    };
    if (ev) {
        let isPageScroller = ev.target === document || ev.target.clientHeight === window.innerHeight;
        if (!isPageScroller) return;  // Ignore scrolling in smaller areas on the page like textarea
        if (ev.target !== document) {
            scrollInfo.scrollY = ev.target.scrollTop;
            scrollInfo.scrollHeight = ev.target.scrollHeight;
        }
        // Do nothing unless scrolled by about 5%
        if (lastKnownScrollY !== undefined && Math.abs(lastKnownScrollY - scrollInfo.scrollY) / window.innerHeight < 0.05) return;
    }
    // Explore if scrolled far enough from the last explored place. Explore once again a bit closer.
    let threshold = exploration.lastScrollY < window.innerHeight ? 0.25 : 0.5;
    let isFar = scrollInfo && Math.abs(exploration.lastScrollY - scrollInfo.scrollY) / window.innerHeight > threshold;
    if (isFar || exploration.limit > 0 || forceExplore) {
        measure('exploreStylesheets', exploreStylesheets);
        measure('exploreStickies', exploreStickies);
        exploration.limit--;
        if (isFar) {
            exploration.limit = 1;
            exploration.lastScrollY = scrollInfo.scrollY;
        }
    }
    stickyFixer.onChange(scrollInfo, forceUpdate);
    if (scrollInfo) {
        lastKnownScrollY = scrollInfo.scrollY;
    }
}

if (window.top === window) {  // Don't do anything within an iframe
    log('Content script initializing (top window)');
    
    // Listen for messages from service worker (for pushed updates)
    chrome.runtime.onMessage.addListener((request) => {
        log('Content script received message:', request.name);
        if (request.name === 'temporaryShowStickies') {
            // Show once. Disabling the stylesheet is simpler than setting and resetting the behavior.
            if (stickyFixer && stickyFixer.stylesheet) {
                stickyFixer.stylesheet.disabled = true;
            }
        
            // Restore the previous behavior after a short delay
            setTimeout(() => {
                if (stickyFixer && stickyFixer.stylesheet) {
                    stickyFixer.stylesheet.disabled = false;
                }
            }, 1000);
        } else if (request.name === 'sheetExplored') {
            log('Processing sheetExplored message:', request.message);
            onSheetExplored(request.message);
        }
    });
    
    // Request initial settings
    log('Requesting initial settings...');
    refreshSettings('initialization');

    // Listen for storage changes
    chrome.storage.onChanged.addListener((changes) => {
        log('Storage changed:', changes);
        
        // Add a small delay to avoid race conditions with page navigation
        setTimeout(() => {
            // Check if we're still the active content script
            if (window.top !== window || document.hidden) {
                log('Skipping settings refresh - not active window');
                return;
            }
            
            // Retrieve settings again when storage changes
            refreshSettings('storage-change');
        }, 100); // Small delay to avoid race conditions
    });

    document.addEventListener('readystatechange', () => {
        log('Document ready state changed to:', document.readyState);
        // Run several times waiting for JS on the page to do the changes affecting scrolling and stickies
        [0, 500].forEach(t => setTimeout(() => stickyFixer && doAll(true, false), t));
    });

    // Listen for tab becoming active/visible to refresh settings
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            log('Tab became visible');
            refreshSettings('tab-visible');
        }
    });

    // Listen for window focus (additional activation detection)
    window.addEventListener('focus', () => {
        log('Window gained focus');
        refreshSettings('window-focus');
    });

    // Listen for pageshow (back/forward navigation)
    window.addEventListener('pageshow', (event) => {
        if (event.persisted) {
            log('Page shown from cache');
            refreshSettings('pageshow-cache');
        }
    });
    
    log('Content script initialization complete');
} else {
    log('Content script skipped (iframe)');
}
