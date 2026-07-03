
    const { createApp, ref, reactive, computed, onMounted, watch, nextTick } = Vue;

    createApp({
      setup() {
        const sidebarCollapsed = ref(false);
        const activeMenu = ref('calendar');
        const activeTab = ref('calendar');
        const globalView = ref('calendar'); 
        const showArtistDropdown = ref(false);
        const API_BASE = '/api/v1';

        const artists = ref([]); const activeArtist = ref({ id: '', name: '', image_url: '', currency: 'EUR' });
        const events = ref([]); const uploadedFiles = ref([]);
        const searchQuery = ref('');

        const currentDate = ref(new Date(2026, 4, 1));
        const modalOpen = ref(false);
        const isEditing = ref(false);
        const form = reactive({ id: '', title: '', venue_name: '', city: '', start_date: '', status: 'option', guarantee_amount: 0, has_contract: false, has_payout: false, notes: '', lat: null, lng: null });

        const menuItems = [ { name: 'calendar', label: 'Gira y Calendario', icon: 'fa-calendar-days' } ];
        const tabs = [ { id: 'calendar', label: 'Calendario Visual', icon: 'fa-calendar' }, { id: 'list', label: 'Lista de Conciertos', icon: 'fa-table-list' }, { id: 'map', label: 'Mapa de Gira', icon: 'fa-map-location-dot' }, { id: 'files', label: 'Archivos Storage', icon: 'fa-folder-open' } ];

        const currentMonthLabel = computed(() => currentDate.value.toLocaleString('es-ES', { month: 'long', year: 'numeric' }));
        const sortedEvents = computed(() => [...events.value].sort((a, b) => a.start_date.localeCompare(b.start_date)));
        const calendarView = ref('monthly');
        const isSynced = ref(false);
        const syncLoading = ref(false);

        const stats = computed(() => {
          let confirmedCount = 0, confirmedGuarantee = 0, optionCount = 0;
          events.value.forEach(e => {
            if (e.status === 'confirmed') { confirmedCount++; confirmedGuarantee += e.guarantee_amount || 0; } else if (e.status === 'option') optionCount++;
          });
          return { confirmedCount, confirmedGuarantee, optionCount, tasksProgress: '0/0' };
        });

        function filterEvents(evtsList) {
          if (!searchQuery.value) return evtsList;
          const query = searchQuery.value.toLowerCase();
          return evtsList.filter(e => e.title.toLowerCase().includes(query) || (e.city && e.city.toLowerCase().includes(query)));
        }

        const calendarDays = computed(() => {
          const year = currentDate.value.getFullYear(); const month = currentDate.value.getMonth();
          let firstDayIndex = new Date(year, month, 1).getDay(); firstDayIndex = firstDayIndex === 0 ? 6 : firstDayIndex - 1;
          const daysInMonth = new Date(year, month + 1, 0).getDate(); const daysInPrevMonth = new Date(year, month, 0).getDate();
          const days = [];
          for (let i = firstDayIndex - 1; i >= 0; i--) { const d = daysInPrevMonth - i; const m = month === 0 ? 11 : month - 1; const y = month === 0 ? year - 1 : year; const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`; days.push({ dayNum: d, currentMonth: false, dateStr, isToday: false, events: events.value.filter(e => e.start_date === dateStr) }); }
          for (let d = 1; d <= daysInMonth; d++) { const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`; days.push({ dayNum: d, currentMonth: true, dateStr, isToday: false, events: events.value.filter(e => e.start_date === dateStr) }); }
          const nextDaysNeeded = (days.length > 35 ? 42 : 35) - days.length;
          for (let d = 1; d <= nextDaysNeeded; d++) { const m = month === 11 ? 0 : month + 1; const y = month === 11 ? year + 1 : year; const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`; days.push({ dayNum: d, currentMonth: false, dateStr, isToday: false, events: events.value.filter(e => e.start_date === dateStr) }); }
          return days;
        });

        async function fetchInitialData() {
          const resA = await fetch(`${API_BASE}/artists`); artists.value = (await resA.json()).artists;
          if (artists.value.length) { activeArtist.value = artists.value[0]; loadArtistEvents(activeArtist.value.id); }
          uploadedFiles.value = (await (await fetch(`${API_BASE}/files`)).json()).files;
        }

        async function loadArtistEvents(id) {
          const res = await fetch(`${API_BASE}/events/by-artist/${id}`); events.value = (await res.json()).events;
          if (document.getElementById('map')) { nextTick(updateMapMarkers); }
        }

        function openCreateModal(dateStr) {
          isEditing.value = false; form.id = ''; form.title = 'Nuevo Evento'; form.city = ''; form.start_date = dateStr || new Date().toISOString().split('T')[0]; form.status = 'option'; form.guarantee_amount = 0; form.has_contract = false; form.has_payout = false; modalOpen.value = true;
        }

        function openEditModal(event) {
          isEditing.value = true; Object.assign(form, JSON.parse(JSON.stringify(event))); modalOpen.value = true;
        }

        async function saveEvent() {
          const payload = { ...form, artist_id: activeArtist.value.id };
          const method = isEditing.value ? 'PUT' : 'POST';
          const url = isEditing.value ? `${API_BASE}/events/${form.id}` : `${API_BASE}/events`;
          const res = await fetch(url, { method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
          if(res.ok){ await loadArtistEvents(activeArtist.value.id); modalOpen.value = false; }
        }

        async function deleteEvent(id) {
          if(!confirm('¿Eliminar evento?')) return;
          await fetch(`${API_BASE}/events/${id}`, { method: 'DELETE' }); await loadArtistEvents(activeArtist.value.id);
        }

        function generateContractPDF() {
          let txt = `CONTRATO DE ACTUACIÓN MUSICAL (HADADANZA)\n\nReunidos por una parte el promotor de ${form.venue_name || '...'} en ${form.city || '...'}, y por otra el grupo ${activeArtist.value.name}.\n\nAmbas partes acuerdan:\n1. Show el día ${formatDate(form.start_date)}.\n2. Garantía de ${form.guarantee_amount} €.\n\nFirmado electrónicamente.`;
          const { jsPDF } = window.jspdf; const doc = new jsPDF();
          doc.setFont("helvetica", "bold"); doc.setFontSize(18); doc.setTextColor(14, 165, 233); doc.text("HADADANZA - CONTRATO", 105, 20, { align: "center" });
          doc.setFont("helvetica", "normal"); doc.setFontSize(11); doc.setTextColor(50, 50, 50); doc.text(doc.splitTextToSize(txt, 170), 20, 35);
          doc.save(`Contrato_${form.title}.pdf`);
        }

        async function toggleCalendarSync() {
          syncLoading.value = true;
          const url = isSynced.value ? `${API_BASE}/unsubscribe` : `${API_BASE}/subscribe`;
          try {
            const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ artistId: activeArtist.value.id }) });
            const data = await res.json(); isSynced.value = data.isSubscribed;
          } catch (err) { console.error(err); } finally { syncLoading.value = false; }
        }

        function prevMonth() { currentDate.value = new Date(currentDate.value.getFullYear(), currentDate.value.getMonth() - 1, 1); }
        function nextMonth() { currentDate.value = new Date(currentDate.value.getFullYear(), currentDate.value.getMonth() + 1, 1); }
        function setToday() { currentDate.value = new Date(); }
        function getEventClasses(status) { return status === 'confirmed' ? 'bg-green-500/10 text-green-500 border-green-500/30' : status === 'option' ? 'bg-amber-500/10 text-amber-500 border-dashed border-amber-500/30' : 'bg-slate-500/10 text-slate-500'; }
        function getEventIcon(status) { return status === 'confirmed' ? 'fa-circle-check' : status === 'option' ? 'fa-circle-question' : 'fa-ban'; }
        function formatStatus(s) { return s==='confirmed'?'Confirmado':s==='option'?'Opción':'Bloqueado'; }
        function getStatusBadgeClass(s) { return s==='confirmed'?'bg-green-100 text-green-800 dark:bg-green-950/30 dark:text-green-300':s==='option'?'bg-amber-100 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300':'bg-slate-100 text-slate-400'; }
        function formatCurrency(a) { return `${Number(a).toLocaleString('es-ES')} €`; }
        function formatDate(d) { if(!d)return''; const p=d.split('-'); return `${p[2]}/${p[1]}/${p[0]}`; }

        const darkTheme = ref(true);
        function toggleTheme() {
          darkTheme.value = !darkTheme.value; const html = document.documentElement;
          if (darkTheme.value) { html.classList.add('theme-dark', 'dark'); html.classList.remove('theme-light'); localStorage.setItem('theme', 'dark'); } else { html.classList.add('theme-light'); html.classList.remove('theme-dark', 'dark'); localStorage.setItem('theme', 'light'); }
        }

        let map = null, markersGroup = null;
        watch(activeTab, (n) => { if(n==='map') nextTick(initMap); });
        watch(searchQuery, () => { if(activeTab.value==='map') updateMapMarkers(); });

        function initMap() {
          if(map) return; map = L.map('map').setView([40.4167, -3.7037], 5);
          L.tileLayer(darkTheme.value ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png' : 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png').addTo(map);
          markersGroup = L.layerGroup().addTo(map); updateMapMarkers();
        }
        function updateMapMarkers() {
          if (!map || !markersGroup) return; markersGroup.clearLayers(); let bounds = [];
          filterEvents(events.value).forEach(evt => {
            if (evt.lat && evt.lng) {
              const marker = L.marker([evt.lat, evt.lng]).bindPopup(`<b>${evt.title}</b><br>${evt.city}`);
              markersGroup.addLayer(marker); bounds.push([evt.lat, evt.lng]);
            }
          });
          if (bounds.length > 0) map.fitBounds(bounds, { padding: [50, 50] });
        }

        onMounted(() => {
          document.documentElement.classList.add('theme-dark', 'dark');
          fetchInitialData();
        });

        return {
          sidebarCollapsed, globalView, activeMenu, activeTab, showArtistDropdown, searchQuery, artists, activeArtist, events, uploadedFiles,
          currentDate, currentMonthLabel, sortedEvents, stats, calendarDays, modalOpen, isEditing, form, menuItems, tabs, darkTheme, calendarView, isSynced, syncLoading, toggleCalendarSync,
          openGlobalView, selectArtist, filterEvents, prevMonth, nextMonth, setToday, openCreateModal, openEditModal, saveEvent, deleteEvent, generateContractPDF, getEventClasses, getEventIcon, formatStatus, getStatusBadgeClass, formatCurrency, formatDate, toggleTheme
        };
      }
    }).mount('#app');
  