const agents = [
    ['Soul Gateway (AssistOSExplorer)', 'https://github.com/AssistOS-AI/AssistOSExplorer/tree/main/soul-gateway'],
    ['SearchAgent (legacy-agents)', 'https://github.com/AssistOS-AI/legacy-agents/tree/main/searchAgent'],
    ['OpenCode Free (legacy-agents)', 'https://github.com/AssistOS-AI/legacy-agents/tree/main/opencode-free'],
];

function repositoryRoot() {
    const url = new URL(window.location.href);
    url.pathname = url.pathname.replace(/[^/]*$/, '');
    url.search = '';
    url.hash = '';
    return url;
}

function link(root, path) {
    return new URL(path, root).href;
}

function menu(label, items, currentPath) {
    const wrapper = document.createElement('div');
    wrapper.className = 'nav-menu';
    const button = document.createElement('button');
    button.className = 'nav-trigger';
    button.type = 'button';
    button.setAttribute('aria-expanded', 'false');
    button.textContent = label;
    const panel = document.createElement('div');
    panel.className = 'nav-panel';
    for (const [itemLabel, href] of items) {
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.textContent = itemLabel;
        if (new URL(href).pathname === currentPath) anchor.setAttribute('aria-current', 'page');
        panel.append(anchor);
    }
    button.addEventListener('click', () => {
        const opening = wrapper.dataset.open !== 'true';
        closeMenus();
        wrapper.dataset.open = String(opening);
        button.setAttribute('aria-expanded', String(opening));
    });
    wrapper.append(button, panel);
    return wrapper;
}

function closeMenus({ returnFocus = false } = {}) {
    document.querySelectorAll('.nav-menu[data-open="true"]').forEach((entry) => {
        entry.dataset.open = 'false';
        const trigger = entry.querySelector('.nav-trigger');
        trigger?.setAttribute('aria-expanded', 'false');
        if (returnFocus) trigger?.focus();
    });
}

function renderHeader() {
    const header = document.querySelector('[data-site-header], header.site-header');
    if (!header || header.dataset.enhanced === 'true') return;
    header.dataset.enhanced = 'true';
    header.className = 'site-header';
    const root = repositoryRoot();
    const inner = document.createElement('div');
    inner.className = 'header-inner';
    const brand = document.createElement('div');
    brand.className = 'brand';
    brand.innerHTML = '<span class="brand-mark" aria-hidden="true"></span><span>Proxy Agents Documentation</span>';
    const nav = document.createElement('nav');
    nav.className = 'nav';
    nav.setAttribute('aria-label', 'Primary documentation navigation');
    const repositoryItems = [
        ['Repository Home', link(root, 'index.html')],
        ...agents,
    ];
    nav.append(menu('Repository', repositoryItems, window.location.pathname));
    inner.append(brand, nav);
    header.replaceChildren(inner);
}

function renderFooter() {
    const footer = document.querySelector('[data-site-footer], footer.site-footer');
    if (!footer || footer.dataset.enhanced === 'true') return;
    footer.dataset.enhanced = 'true';
    footer.className = 'site-footer';
    const research = '<p>Research conducted by <a href="https://www.axiologic.net">Axiologic Research</a> as part of the European research project <a href="https://www.achilles-project.eu/">Achilles</a>.</p>';
    footer.innerHTML = `<div class="footer-inner">${research}</div>`;
}

export function initSite() {
    renderHeader();
    renderFooter();
}

document.addEventListener('click', (event) => {
    if (!event.target.closest('.nav-menu')) closeMenus();
});
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenus({ returnFocus: true });
});

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initSite);
else initSite();
