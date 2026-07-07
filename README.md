# Tecnoland Admin

Primer módulo funcional del sistema: gestión de inventario.

## Importación masiva

Desde **Inventario → Importar** se aceptan archivos `.xlsx` y `.csv` de hasta 1,000 filas y 5 MB. Las columnas reconocidas son:

`SKU`, `Producto`, `Categoría`, `Color`, `Costo`, `Precio`, `Stock`, `Alerta` y `Descripción`.

La combinación de SKU del proveedor y color determina si se crea una variante nueva o se actualiza una existente. Antes de importar se muestra una vista previa con errores por fila. Las altas, actualizaciones y eliminaciones se conservan en `inventory_history`.

Los productos pueden copiarse para crear variantes editables con un SKU interno nuevo. Al desactivar un producto, permanece visible para gestión e historial, pero deja de participar en métricas y pedidos nuevos; los pedidos existentes conservan su SKU.

La búsqueda superior muestra coincidencias instantáneas agrupadas por productos, categorías, pedidos y clientes. El buscador de la tabla de inventario filtra únicamente por nombre o SKU del producto.

La sección Entregas resume pedidos en tránsito, cancelados y entregados; permite filtrar y buscar por información logística, y abre el detalle completo al seleccionar el número interno del pedido.

Los modales distinguen un clic real en el fondo de una selección arrastrada desde un campo. El selector de productos de pedidos incluye búsqueda por nombre o SKU y actualiza la vista previa e imagen al cambiar la selección.

El selector de productos muestra resultados visuales desplegables y reinicia la cantidad en uno. Desde el detalle de un pedido se puede actualizar el estado, registrar el monto cobrado por courier y adjuntar información o una fotografía de la boleta.

## Ejecutar

```bash
npm start
```

Abre `http://127.0.0.1:3001`.

## Persistencia de datos

En producción, Tecnoland usa PostgreSQL administrado por Supabase. Las tablas `products` e `inventory_history` se crean con:

```bash
npm run db:init
```

Vercel inyecta de forma segura las variables de conexión de Supabase; `.env.local` nunca se publica en Git.

## Variables de seguridad

En producción debes configurar estas variables antes de desplegar:

- `POSTGRES_URL` o `POSTGRES_URL_NON_POOLING`
- `TECNOLAND_AUTH_SECRET` o `AUTH_SECRET`: secreto aleatorio largo para firmar sesiones
- `TECNOLAND_ADMIN_PASSWORD`: solo se usa al crear el primer usuario administrador en una base vacía

Los usuarios existentes no se modifican ni se eliminan por estos cambios. Si tu base ya tiene usuarios activos, `TECNOLAND_ADMIN_PASSWORD` no se vuelve a aplicar.

## Endurecimiento aplicado

- La sesión web ahora usa cookie `HttpOnly` en lugar de depender del token en JavaScript.
- El panel mantiene la sesión del navegador actual, pero ya no persiste credenciales entre cierres completos del navegador.
- `exceljs` se sirve localmente desde el proyecto para evitar depender de un CDN en producción y permitir una política CSP más estricta.

### Desarrollo local

El inventario se guarda en `data/inventory.json` y cada movimiento se registra en `data/inventory-history.jsonl`. Ambos archivos están excluidos de Git, por lo que publicar cambios de código no reemplaza los datos ni su historial.

`data/seed-products.json` contiene únicamente los datos iniciales para una instalación nueva. Puedes montar `data/` como volumen persistente o indicar otra ubicación con la variable `DATA_DIR`:

```bash
DATA_DIR=/ruta/persistente npm start
```

Al abrir esta versión por primera vez, los productos guardados por la versión anterior en el navegador se migran automáticamente a la base del servidor.

El archivo JSON persistente se conserva únicamente como alternativa local. El despliegue de Vercel usa Supabase, por lo que publicar una versión nueva no reemplaza productos ni historial.
