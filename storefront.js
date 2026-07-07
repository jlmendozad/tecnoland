const state = {
  products: [],
  filters: {
    query: '',
    category: 'all',
    availability: 'all',
    sort: 'featured'
  },
  selectedProduct: null
};

const $ = selector => document.querySelector(selector);
const money = value => new Intl.NumberFormat('es-GT', { style: 'currency', currency: 'GTQ', currencyDisplay: 'narrowSymbol' }).format(Number(value || 0));
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const formatDate = value => {
  if (!value) return 'En línea';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'En línea' : `Actualizado ${new Intl.DateTimeFormat('es-GT', { dateStyle: 'medium', timeStyle: 'short' }).format(date)}`;
};

function productImage(product) {
  return product.images?.[0]?.url || 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640">
      <rect width="640" height="640" rx="56" fill="${product.themeColor || '#ffe4d8'}"/>
      <text x="50%" y="52%" text-anchor="middle" dominant-baseline="middle" font-family="Arial, sans-serif" font-size="180">${product.emoji || '📦'}</text>
    </svg>
  `);
}

function stockState(product) {
  if (product.stock <= 0) return { label: 'Agotado', className: 'out' };
  if (product.stock <= 3) return { label: `Quedan ${product.stock}`, className: 'low' };
  return { label: 'Disponible', className: 'available' };
}

function filteredProducts() {
  const { query, category, availability, sort } = state.filters;
  const list = state.products.filter(product => {
    const haystack = normalize(`${product.name} ${product.category} ${product.productColor} ${product.description}`);
    if (query && !haystack.includes(normalize(query))) return false;
    if (category !== 'all' && product.category !== category) return false;
    if (availability === 'in-stock' && product.stock <= 0) return false;
    if (availability === 'low-stock' && (product.stock <= 0 || product.stock > 3)) return false;
    if (availability === 'out-of-stock' && product.stock > 0) return false;
    return true;
  });

  if (sort === 'price-asc') list.sort((a, b) => a.price - b.price);
  else if (sort === 'price-desc') list.sort((a, b) => b.price - a.price);
  else if (sort === 'name-asc') list.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  else list.sort((a, b) => (b.stock > 0) - (a.stock > 0) || b.price - a.price);

  return list;
}

function renderCategories() {
  const categories = [...new Set(state.products.map(product => product.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  $('#categoryFilter').innerHTML = ['<option value="all">Todas</option>', ...categories.map(category => `<option value="${category}">${category}</option>`)].join('');
  $('#categoryFilter').value = state.filters.category;
  $('#categoryPills').innerHTML = [
    `<button class="category-pill ${state.filters.category === 'all' ? 'active' : ''}" type="button" data-category-pill="all">Todo</button>`,
    ...categories.map(category => `<button class="category-pill ${state.filters.category === category ? 'active' : ''}" type="button" data-category-pill="${category}">${category}</button>`)
  ].join('');
}

function renderStats() {
  const categories = new Set(state.products.map(product => product.category).filter(Boolean));
  const totalStock = state.products.reduce((sum, product) => sum + Number(product.stock || 0), 0);
  const latestUpdate = state.products.reduce((latest, product) => {
    const time = new Date(product.updatedAt || 0).getTime();
    return time > latest ? time : latest;
  }, 0);
  const highlight = state.products.find(product => product.stock > 0) || state.products[0];

  $('#statProducts').textContent = String(state.products.length);
  $('#statCategories').textContent = String(categories.size);
  $('#statStock').textContent = String(totalStock);
  $('#heroUpdatedAt').textContent = latestUpdate ? formatDate(latestUpdate) : 'En línea';

  if (highlight) {
    $('#heroHighlightTitle').textContent = highlight.name;
    $('#heroHighlightText').textContent = `${highlight.category} · ${highlight.productColor} · ${money(highlight.price)}${highlight.stock > 0 ? ` · ${highlight.stock} disponibles` : ' · agotado por ahora'}`;
  }
}

function renderProducts() {
  const grid = $('#productsGrid');
  const template = $('#productCardTemplate');
  const products = filteredProducts();
  $('#resultsCount').textContent = `${products.length} producto${products.length === 1 ? '' : 's'}`;

  if (!products.length) {
    grid.innerHTML = '<div class="empty-state"><strong>No encontramos productos con esos filtros.</strong><p>Prueba otra categoría, limpia filtros o ajusta la búsqueda.</p></div>';
    return;
  }

  grid.innerHTML = '';
  for (const product of products) {
    const node = template.content.firstElementChild.cloneNode(true);
    const button = node.querySelector('.product-card-button');
    const image = node.querySelector('.product-image');
    const stock = node.querySelector('.product-stock');
    const status = stockState(product);

    image.src = productImage(product);
    image.alt = product.name;
    stock.textContent = status.label;
    stock.className = `stock-pill product-stock ${status.className}`;
    node.querySelector('.product-category').textContent = product.category || 'Tecnología';
    node.querySelector('.product-name').textContent = product.name;
    node.querySelector('.product-description').textContent = product.description || 'Consulta disponibilidad y detalles de este producto desde el catálogo de Tecnoland.';
    node.querySelector('.product-price').textContent = money(product.price);
    node.querySelector('.product-meta').textContent = `${product.productColor || 'Sin especificar'} · ${product.stock} unidad${product.stock === 1 ? '' : 'es'}`;
    button.addEventListener('click', () => openProductModal(product.id));
    grid.appendChild(node);
  }
}

function render() {
  renderCategories();
  renderStats();
  renderProducts();
}

function updateFilter(key, value) {
  state.filters[key] = value;
  render();
}

function openProductModal(productId) {
  const product = state.products.find(item => item.id === productId);
  if (!product) return;
  state.selectedProduct = product;
  const status = stockState(product);
  $('#productModalImage').src = productImage(product);
  $('#productModalImage').alt = product.name;
  $('#productModalCategory').textContent = product.category || 'CATÁLOGO';
  $('#productModalTitle').textContent = product.name;
  $('#productModalPrice').textContent = money(product.price);
  $('#productModalDescription').textContent = product.description || 'Producto disponible en el catálogo digital de Tecnoland.';
  $('#productModalColor').textContent = product.productColor || 'Sin especificar';
  $('#productModalQuantity').textContent = `${product.stock} unidad${product.stock === 1 ? '' : 'es'}`;
  $('#productModalStock').textContent = status.label;
  $('#productModalStock').className = `stock-pill ${status.className}`;
  $('#productModal').hidden = false;
}

function closeProductModal() {
  $('#productModal').hidden = true;
}

async function copyText(text, confirmation) {
  try {
    await navigator.clipboard.writeText(text);
    alert(confirmation);
  } catch {
    alert(text);
  }
}

async function loadProducts() {
  $('#productsGrid').innerHTML = '<div class="loading-state"><strong>Cargando catálogo…</strong><p>Estamos trayendo los productos activos desde Tecnoland.</p></div>';
  try {
    const response = await fetch('/api/products', { credentials: 'same-origin' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'No fue posible cargar el catálogo.');
    state.products = Array.isArray(data) ? data : [];
    render();
  } catch (error) {
    $('#productsGrid').innerHTML = `<div class="error-state"><strong>No pudimos cargar el catálogo.</strong><p>${error.message}</p></div>`;
  }
}

$('#searchInput').addEventListener('input', event => updateFilter('query', event.target.value.trim()));
$('#categoryFilter').addEventListener('change', event => updateFilter('category', event.target.value));
$('#availabilityFilter').addEventListener('change', event => updateFilter('availability', event.target.value));
$('#sortFilter').addEventListener('change', event => updateFilter('sort', event.target.value));
$('#resetFiltersButton').addEventListener('click', () => {
  state.filters = { query: '', category: 'all', availability: 'all', sort: 'featured' };
  $('#searchInput').value = '';
  $('#categoryFilter').value = 'all';
  $('#availabilityFilter').value = 'all';
  $('#sortFilter').value = 'featured';
  render();
});
$('#categoryPills').addEventListener('click', event => {
  const pill = event.target.closest('[data-category-pill]');
  if (!pill) return;
  state.filters.category = pill.dataset.categoryPill;
  $('#categoryFilter').value = state.filters.category;
  render();
});
$('#closeProductModal').addEventListener('click', closeProductModal);
$('#productModal').addEventListener('click', event => {
  if (event.target.id === 'productModal') closeProductModal();
});
$('#copyReferenceButton').addEventListener('click', () => {
  if (!state.selectedProduct) return;
  copyText(
    `Hola, me interesa "${state.selectedProduct.name}" en color ${state.selectedProduct.productColor}. Precio ${money(state.selectedProduct.price)}.`,
    'Referencia copiada para compartir.'
  );
});
$('#shareProductButton').addEventListener('click', async () => {
  if (!state.selectedProduct) return;
  const text = `${state.selectedProduct.name} · ${money(state.selectedProduct.price)} · ${window.location.href.split('#')[0]}#catalogo`;
  if (navigator.share) {
    try {
      await navigator.share({ title: state.selectedProduct.name, text, url: window.location.href });
      return;
    } catch {}
  }
  copyText(text, 'Detalle copiado para compartir.');
});
$('#shareCatalogButton').addEventListener('click', async () => {
  const url = window.location.href;
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Tecnoland', text: 'Explora el catálogo de Tecnoland', url });
      return;
    } catch {}
  }
  copyText(url, 'Enlace del catálogo copiado.');
});

loadProducts();
