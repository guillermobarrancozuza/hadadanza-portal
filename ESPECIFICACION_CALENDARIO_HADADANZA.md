# Documento de Especificación de Software: HADADANZA - Calendario del Artista

Este documento detalla las especificaciones técnicas, funcionales, de diseño y de arquitectura para el sistema de planificación, almacenamiento de archivos, contratos y balances financieros de la banda **HADADANZA** (`/artist/:artistId/calendar`).

---

## 1. Introducción y Propósito del Sistema

### 1.1 ¿Qué es HADADANZA?
**HADADANZA** es una banda española de Celtic Folk Rock / Metal que requiere de una infraestructura integrada para la gestión autónoma de sus giras, conciertos, riders técnicos, presupuestos, contratos automatizados, tareas de producción y almacenamiento de prensa (EPK) y partituras.

### 1.2 El Calendario de HADADANZA (`/artist/:artistId/calendar`)
Es el panel central desde el cual la banda, sus mánagers, técnicos y músicos de sesión pueden ver, añadir y editar de forma interactiva todas las fechas de conciertos, grabaciones de estudio, ensayos generales, vacaciones y entrevistas promocionales.

---

## 2. Arquitectura de Navegación y Rutas (Routing)

La aplicación web de HADADANZA está desarrollada como una Single Page Application (SPA) conectada a un servidor API local en Express.

### 2.1 Mapeo de Rutas del Frontend

| Ruta URL | Nombre de la Ruta | Componente Asociado | Propósito / Comportamiento |
| :--- | :--- | :--- | :--- |
| `/` | `home-page` | `DashboardLayout` + `Home` | Redirecciona automáticamente a la sección del calendario de la banda HADADANZA. |
| `/artist/:artistId/calendar/:year?` | `artist-calendar-page` | `ArtistCalendar` | **Módulo Principal**. Calendario interactivo mensual/anual con listado de conciertos y visualización de mapa geolocalizado. |
| `/contacts` | `contacts-page` | `ContactsCRM` | Listado y base de datos (CRM) de salas de conciertos, festivales y técnicos de sonido/luces. |
| `/tasks` | `task-templates-page` | `TaskTemplates` | Plantillas de listas de verificación de producción (ej. "Preparativos de Festival" o "Show acústico"). |
| `/balances` | `balances-page` | `FinancialBalances` | Resumen de presupuestos de gira, facturas liquidadas y contratos pendientes por cobrar. |

---

## 3. Características Premium / PRO del MVP de HADADANZA

A diferencia de la versión básica, el clon de HADADANZA incorpora de manera nativa y local las tres grandes características de la suscripción de pago (PRO) de la plataforma original:

### 3.1 Gestor de Archivos y Storage Local Directo (`/storage`)
- Permite subir, listar, descargar y eliminar archivos reales directamente desde la computadora del mánager de HADADANZA.
- Ideal para almacenar partituras, riders de sonido de festivales, el kit de prensa electrónico (EPK) y los PDFs de contratos firmados.
- Almacenamiento directo en el disco duro local, sin límites de espacio de la nube y sin cargos por suscripción mensual.

### 3.2 Generador de Contratos Automatizados y Exporte a PDF (`/contract-templates`)
- Dispone de un redactor de contratos con un sistema de plantillas que auto-completa los datos del concierto (ej. `{{FECHA}}`, `{{GARANTIA}}`, `{{LUGAR}}`, `{{CIUDAD}}`) con la información cargada en el calendario.
- Un botón integrado en cada concierto permite exportar y descargar el contrato completo en PDF en cuestión de segundos, listo para su firma digital.

### 3.3 Sincronización Local y Tolerancia a Fallos (Offline Mode)
- Si por alguna razón la banda no dispone de conexión a internet durante una gira, la aplicación continúa siendo 100% funcional. El cliente realiza el almacenamiento y los cambios directamente en el `localStorage` del navegador y los sincroniza al volver a conectarse.

---

## 4. Base de Datos Relacional (db.json)

El esquema de persistencia se compone de una estructura en formato JSON que asocia:
- **Artistas (`artists`)**: Hadadanza, Luna Eclipse.
- **Eventos (`events`)**: Shows del grupo con sus coordenadas de mapas, notas del rider, y hitos financieros (si se ha firmado el contrato y si se ha liquidado el adelanto).
- **Contactos (`contacts`)**: Directorio de promotores de salas de rock/metal y festivales.
- **Plantillas de Tareas (`task_templates`)**: Listas de control que se pueden arrastrar al añadir conciertos.
- **Archivos (`files`)**: Lista indexada de los documentos cargados en el disco duro físico del servidor.
- **Plantillas de Contratos (`contract_templates`)**: Plantillas contractuales con marcadores dinámicos.
