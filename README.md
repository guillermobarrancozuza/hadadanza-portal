# Portal de Giras, Calendario y Contratos: HADADANZA

Este es un **Portal Web Full-Stack y Sistema de Gestión** 100% funcional desarrollado específicamente para la banda **HADADANZA** (Celtic Folk Rock), adaptado a partir del análisis y especificación del sistema original de planificación de giras.

## 🚀 Características Premium Integradas
1. **Calendario Mensual y Anual Interactivo (Vue 3 + Tailwind CSS)**:
   * **Visualización Codificada**: Shows confirmados (Verde/Cian), Propuestas en negociación (Ámbar) y Ensayos/Bloqueos de estudio (Gris con candado).
   * **Badges de Hitos en Celdas**: Indicadores rápidos de Contrato Firmado (`DOC`), Adelanto Cobrado (`PAG`) y barra de progreso de tareas del show (ej. `2/3 T`).
   * **Buscador Reactivo**: Filtra los shows, el mapa y las tablas en tiempo real con solo empezar a escribir una ciudad o sala.
2. **Generador y Exportador de Contratos en PDF (jsPDF)**:
   * Un editor inteligente integrado que autocompleta plantillas de contrato con variables del concierto (`{{ARTISTA}}`, `{{LUGAR}}`, `{{CIUDAD}}`, `{{FECHA}}`, `{{GARANTIA}}`) y permite **descargar un contrato legal real en PDF** firmado electrónicamente con un diseño profesional de HADADANZA.
3. **HADADANZA Storage (Disco Virtual Local)**:
   * Un gestor de archivos real que permite subir, indexar, descargar y eliminar documentos físicos directamente en el disco duro de tu computadora (`/storage`). Ideal para guardar partituras de flauta, violín, riders de sonido de festivales, dossiers de prensa y PDFs de contratos firmados.
4. **CRM de Contactos e Hitos**:
   * Directorio (CRM) completo de promotores de festivales de metal, salas de conciertos y personal de staff técnico para una comunicación rápida.
5. **Contabilidad y Balances de Gira**:
   * Panel de control que calcula en tiempo real el Caché Total Proyectado de la gira, los Adelantos Cobrados y el Saldo Restante por Liquidar.
6. **Selector de Banda y Creador Multiórganico**:
   * Permite alternar calendarios entre la banda principal HADADANZA y otros artistas, con soporte para crear nuevos artistas en la base de datos de manera inmediata.

---

## 🛠️ Instrucciones de Instalación y Uso

Asegúrate de tener **Node.js** instalado en tu computadora.

### Paso 1: Instalar dependencias del servidor
Abre una terminal en el directorio raíz del proyecto (`C:\Users\M0M0\Desktop\App2`) y ejecuta:
```bash
npm install
```

### Paso 2: Iniciar el Servidor de Giras
Ejecuta en tu consola:
```bash
npm start
```
Esto encenderá el servidor en el puerto **3000**:
`http://localhost:3000`

### Paso 3: Usar la Aplicación
1. Abre tu navegador e ingresa a: **`http://localhost:3000`**
2. **Prueba el Storage**: Ve a la pestaña **Disco y Archivos (Storage)** del menú de pestañas, selecciona un documento real (como un PDF de rider técnico o imagen) y súbelo. El archivo se guardará físicamente en la carpeta `/storage` del proyecto y aparecerá listado. Puedes hacer clic en descargar para recuperarlo o eliminarlo del disco.
3. **Exporta un Contrato en PDF**: Haz clic en el concierto **HADADANZA en Leyendas del Rock** (28 de Mayo de 2026), presiona el botón azul *"Exportar PDF"* y verás cómo se descarga en tu computadora un contrato de actuación redactado y formateado a la perfección de forma automatizada.
4. **Filtra en Vivo**: Escribe "Leyendas" en la barra superior de búsqueda para ver cómo se resalta únicamente el festival de Villena.
5. **Gestiona Tareas**: Marca o añade tareas como *"Afinar gaitas y violines"* o *"Comprar hidromiel para catering"* y observa los progresos en vivo.
