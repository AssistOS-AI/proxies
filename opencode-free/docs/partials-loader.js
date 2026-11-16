(async () => {
    const includes = [...document.querySelectorAll('[data-include]')];
    await Promise.all(includes.map(async (element) => {
        const response = await fetch(element.dataset.include);
        if (!response.ok) throw new Error(`Could not load ${element.dataset.include}`);
        element.outerHTML = await response.text();
    }));
    const module = await import('../../assets/site.js');
    module.initSite();
})().catch((error) => console.error(error));
