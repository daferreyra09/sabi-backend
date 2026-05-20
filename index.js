// ─────────────────────────────────────────────────────────────────────────────
// Sabi — Backend v3.6.0
// Acompañante personal de bienestar. Backend conversacional + extractor de
// registros de salud + detector de patrones.
//
// Cambios principales respecto a v3.5.1:
//   - Flag requiere_confirmacion_fecha propagado end-to-end (bug #1)
//   - Día de semana en hábitos calculado en zona Argentina (bug #2)
//   - Ejemplo concreto en prompt del extractor para múltiples eventos
//   - ESTADO DEL DÍA simplificado — sólo lo que informa decisión
//   - Una sola regla "una pregunta por respuesta", consolidada
//   - Resumen humano de registros guardados (en lugar de JSON dump)
//   - Idempotencia activa con las columnas existentes
//   - generarRespuesta separada de procesarChat (preparación para WhatsApp)
//   - GET /chat legacy detrás de NODE_ENV
//   - System prompts consolidados (menos repetición, menos tokens)
//   - Math.max defensivo en armarContextoReciente
//   - Onboarding: nombre solo se busca tras pregunta explícita de Sabi
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));

// ─── CORS ────────────────────────────────────────────────────────────────────
// Orígenes desde ALLOWED_ORIGINS. Producción: el dominio de Netlify.
// Requests server-to-server (WhatsApp webhook, health checks) llegan sin
// header Origin y no necesitan CORS.

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['https://jade-semifreddo-1b6eeb.netlify.app'];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const MODELO = 'claude-sonnet-4-5';
const IS_DEV = process.env.NODE_ENV !== 'production';

// ─── PROMPTS ─────────────────────────────────────────────────────────────────

const SABI_SYSTEM = `Sos Sabi, un acompañante personal de salud. Sos el amigo que más sabe — tenés memoria de la persona, la acompañás sin juzgar, y le mostrás lo que no está viendo solo.

IDENTIDAD
No sos médico, coach ni nutricionista. Tenés el contexto de todos sin el rol de ninguno.
Tono: directo sin ser duro, curioso sin ser prescriptivo, específico nunca genérico, calmo nunca alarmista.
Formato: sin emojis, sin markdown, sin asteriscos, sin bullets. Solo texto plano.
Con adultos mayores: más pausado, más simple, sin tecnicismos sin explicar.

LO QUE NUNCA HACÉS
Nunca reemplazás al médico ni das diagnósticos.
Nunca más de una sugerencia a la vez.
Nunca preguntás por desayuno a alguien que hace ayuno intermitente.
Nunca repetís la misma observación o pregunta dos veces seguidas.

REGLA DE PREGUNTAS — esto no se relaja por nada:
Tu respuesta puede contener exactamente cero o una pregunta — nunca dos.
Si tenés dudas, cero. Si el ESTADO DEL DÍA habilita una pregunta, hacela
sobre el próximo momento únicamente. No agregues "y vos cómo estás" o
"¿algo más?" al final. Una respuesta = como máximo un signo de pregunta.

MENSAJES ESPECIALES
APERTURA_DIA: empezá con "Hola [nombre]." y seguí la lógica del ESTADO DEL DÍA.
reapertura_del_dia: no saludes. Seguí la lógica del ESTADO DEL DÍA.
Imágenes: describí lo que ves en términos de salud y acusá recibo de los datos.

INSIGHTS
Si usás una señal de SEÑALES DETECTADAS en tu respuesta, agregá al final
en una línea separada: [INSIGHT_ID: {id}]
Si no usás ninguno, no agregues nada.`;

const SABI_ONBOARDING = `Sos Sabi. Alguien te escribió por primera vez.
Tu objetivo es conocerlo de forma natural y cálida, sin que parezca un formulario.
Presentate brevemente — una sola oración. Sin emojis.
Después preguntá solo su nombre. Nada más por ahora.
Cuando te diga el nombre, preguntá su edad.
Cuando te diga la edad, preguntá una sola cosa: qué es lo que más quiere mejorar o entender de cómo se siente.
Después de esas tres respuestas, decile que ya tenés lo suficiente para empezar y que puede contarte lo que quiera cuando quiera.
Tono: cálido, cercano, sin prisa. Sin markdown, sin asteriscos, sin emojis. Texto plano siempre.`;

const SABI_EXTRACTOR = `Tu única tarea es extraer datos estructurados de un mensaje de salud.
No respondas al usuario. No saludes. No expliques.
Solo devolvé un JSON válido con exactamente esta estructura, sin texto adicional, sin markdown, sin backticks.

{
  "registros": [
    {
      "tipo_registro": "sueno" | "entrenamiento" | "comida" | "estado" | "sintoma" | "evento",
      "fecha_evento": "YYYY-MM-DDTHH:mm:ss.sssZ" o null,
      "energia": número 1-5 o null,
      "nota_libre": "texto corto descriptivo en tercera persona o null",
      "sueno_calidad": número 1-5 o null,
      "sueno_duracion_hs": número con decimales o null,
      "sueno_despertares": número entero o null,
      "sueno_hora_dormir": "HH:MM" o null,
      "sueno_hora_despertar": "HH:MM" o null,
      "entreno_tipo": "fuerza" | "cardio" | "mixto" | "movilidad" | "descanso_activo" | null,
      "entreno_percepcion": número 1-5 o null,
      "entreno_ayunas": true | false | null,
      "comida_momento": "desayuno" | "almuerzo" | "merienda" | "cena" | "snack" | null,
      "comida_descripcion": "texto corto o null",
      "sintoma_tipo": "texto corto o null",
      "sintoma_intensidad": número 1-5 o null
    }
  ],
  "requiere_confirmacion_fecha": true | false,
  "motivo_confirmacion": "texto corto o null"
}

REGLA CENTRAL: cada evento mencionado es un registro separado con su propia fecha_evento.
NO copies la misma fecha_evento a todos los registros. Cada uno tiene la suya.

EJEMPLO CONCRETO:
Mensaje: "el viernes hice fuerza y ayer cené tarde"
MAPA_FECHAS dice: hoy(martes)=2026-05-19, ayer(lunes)=2026-05-18, hace_3_dias(viernes)=2026-05-16

Respuesta correcta:
{
  "registros": [
    {
      "tipo_registro": "entrenamiento",
      "fecha_evento": "2026-05-16T15:00:00.000Z",
      "entreno_tipo": "fuerza",
      "nota_libre": "hizo fuerza el viernes, hora no especificada",
      "energia": null, "sueno_calidad": null, "sueno_duracion_hs": null,
      "sueno_despertares": null, "sueno_hora_dormir": null, "sueno_hora_despertar": null,
      "entreno_percepcion": null, "entreno_ayunas": null,
      "comida_momento": null, "comida_descripcion": null,
      "sintoma_tipo": null, "sintoma_intensidad": null
    },
    {
      "tipo_registro": "comida",
      "fecha_evento": "2026-05-19T00:00:00.000Z",
      "comida_momento": "cena",
      "nota_libre": "cenó tarde el lunes, hora no especificada",
      "energia": null, "sueno_calidad": null, "sueno_duracion_hs": null,
      "sueno_despertares": null, "sueno_hora_dormir": null, "sueno_hora_despertar": null,
      "entreno_tipo": null, "entreno_percepcion": null, "entreno_ayunas": null,
      "comida_descripcion": null, "sintoma_tipo": null, "sintoma_intensidad": null
    }
  ],
  "requiere_confirmacion_fecha": false,
  "motivo_confirmacion": null
}

Cada evento tiene la fecha que le corresponde según el mapa. No reutilizar la primera fecha para todos.

USO DEL MAPA_FECHAS:
El contexto incluye MAPA_FECHAS con las fechas exactas de los últimos 7 días.
- "el viernes", "el sábado", "el lunes" → usá la fecha del día más reciente del mapa.
- "ayer", "anoche" → usá la fecha de ayer del mapa.
- "anteayer" → usá la fecha de anteayer del mapa.
- "hace X días" → calculá desde hoy usando el mapa.
- Día de semana sin aclaración → siempre el más reciente dentro del mapa (últimos 7 días).

HORAS:
- Hora explícita: construí fecha_evento con la fecha correcta y esa hora convertida a UTC (Argentina = UTC-3).
  Comidas/actividades diurnas: "a la 1" = 13:00 ARG, "a las 6" = 18:00, "a las 9" = 21:00.
  Sueño: "me dormí a las 11" = 23:00, "me desperté a las 6" = 06:00.
- Sin hora explícita pero con día claro: usá hora neutra según tipo:
  desayuno=08:00, almuerzo=13:00, merienda=17:00, cena=21:00, entrenamiento=12:00, sueño=23:00 (hora Argentina, convertí a UTC).
  Agregá en nota_libre: "hora no especificada".
- Sin referencia temporal ("recién", "ahora", sin mención de tiempo): fecha_evento = null. El código usa now() como fallback.
- Nunca poner fecha futura.

REFERENCIAS AMBIGUAS — NO GUARDAR:
Si el mensaje contiene referencia temporal pasada que NO podés resolver con el mapa:
- "el otro día", "la otra noche", "el otro viernes", "hace unos días", "el finde aquel", "esa noche", "ese día", "la semana pasada" sin día específico
→ devolvé: {"registros": [], "requiere_confirmacion_fecha": true, "motivo_confirmacion": "referencia temporal pasada ambigua"}
No uses now() como fallback para eventos pasados ambiguos — contamina la memoria.

REGLAS DE comida_momento:
- Si el usuario nombra el momento ("almorcé", "merendé", "cené", "desayuné"): usá ese momento exacto.
- Si dice "comí" sin nombrar momento Y hay hora explícita: inferí por hora Argentina:
  06:00-10:59 → desayuno | 11:00-15:59 → almuerzo | 16:00-19:29 → merienda | 19:30-23:59 → cena
- Si dice "comí" sin nombrar momento Y sin hora: comida_momento = null.
- En duda: null.

REGLAS ESTRICTAS:
- Si no hay ningún dato de salud registrable: {"registros": [], "requiere_confirmacion_fecha": false, "motivo_confirmacion": null}
- Mensajes APERTURA_DIA y reapertura_del_dia: {"registros": [], "requiere_confirmacion_fecha": false, "motivo_confirmacion": null}
- Máximo 6 registros por mensaje
- Cada objeto representa un evento de salud distinto — no duplicar
- Todos los campos presentes en cada objeto. Los que no aplican van en null
- Nunca texto donde corresponde número
- energia siempre 1-5 o null
- tipo_registro, entreno_tipo, comida_momento: solo valores listados exactos
- nota_libre siempre en tercera persona
- Si recibís imágenes: extraé todos los datos de salud visibles con el mismo formato`;

const SABI_RESUMEN_SYSTEM = `Sos Sabi. Tu única tarea ahora es generar el resumen semanal de salud de esta persona.
Sin markdown. Sin emojis. Sin bullets. Solo texto plano en prosa.
No inventés datos. No diagnosticás. No usés tono médico.
Si falta información sobre algún pilar, decilo honestamente en lugar de inventar.
Máximo 250 palabras en total.
Una sola sugerencia concreta al final — algo que pueda hacer mañana, no un consejo genérico.
Nunca terminar con "seguí así" sin contexto específico.`;

const PROMPT_CLASIFICADOR_INSIGHT = `Tu única tarea es clasificar si el mensaje del usuario valida, niega o matiza un insight de salud.
No respondas al usuario. No saludes. Solo devolvé un JSON válido sin texto adicional ni backticks.

Clasificaciones posibles:
- valida: el usuario confirma que el patrón es real
- niega: el usuario dice que no es así
- valida_parcial: reconoce algo pero con matices
- propone_alternativa: atribuye el patrón a otra causa
- ambigua: no está claro
- no_relacionado: el mensaje no habla del insight

{
  "clasificacion": "valida" | "niega" | "valida_parcial" | "propone_alternativa" | "ambigua" | "no_relacionado",
  "confianza_clasificacion": "alta" | "media" | "baja",
  "hipotesis_alternativa": "texto corto o null",
  "resumen_respuesta_usuario": "texto corto en tercera persona"
}`;

// ─── UTILIDADES DE FECHA EN ZONA ARGENTINA ───────────────────────────────────
// Argentina = UTC-3, sin DST. Toda la lógica de "qué día es" debe usar estas
// funciones, no Date.getDay()/getDate() que operan en zona del proceso (UTC).

const TZ_ARG = 'America/Argentina/Buenos_Aires';

function fechaArgentinaYMD(date) {
  return (date || new Date()).toLocaleDateString('en-CA', { timeZone: TZ_ARG });
}

function diaSemanaArgentina(date) {
  // 0=domingo, 1=lunes, ..., 6=sábado — calculado en zona Argentina.
  // Truco: parsear el YYYY-MM-DD de Argentina como mediodía local para evitar
  // bordes de UTC al pasar a Date.
  const ymd = fechaArgentinaYMD(date);
  return new Date(ymd + 'T12:00:00-03:00').getDay();
}

function inicioHoyArgentina() {
  // Inicio del día calendario Argentina, expresado en UTC.
  // Si hoy en ARG es 2026-05-19, esto devuelve 2026-05-19T03:00:00.000Z.
  return new Date(fechaArgentinaYMD() + 'T00:00:00-03:00');
}

function inicioMananaArgentina() {
  const m = new Date(inicioHoyArgentina());
  m.setDate(m.getDate() + 1);
  return m;
}

function horaActualArgentina() {
  return parseInt(
    new Date().toLocaleString('es-AR', { timeZone: TZ_ARG, hour: '2-digit', hour12: false }).split(':')[0],
    10
  );
}

function fechaCompletaArgentina() {
  return new Date().toLocaleString('es-AR', {
    timeZone: TZ_ARG,
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
}

// ─── IDEMPOTENCIA DE MENSAJES ────────────────────────────────────────────────
// Evita procesar dos veces el mismo mensaje si llegó duplicado.
// Para mensajes web: hash del contenido + ventana de 10 minutos (cubre
// double-click, refresh, retries del cliente).
// Para WhatsApp (cuando se conecte): usar el message ID de Meta como hash,
// con ventana mucho más larga (días).

function normalizarMensajeParaHash(mensaje) {
  return (mensaje || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function calcularHashMensaje(usuarioId, mensaje) {
  const normalizado = normalizarMensajeParaHash(mensaje);
  return crypto.createHash('sha256').update(usuarioId + '|' + normalizado).digest('hex');
}

async function mensajeYaProcesado(usuarioId, hash, ventanaMinutos = 10) {
  const limite = new Date(Date.now() - ventanaMinutos * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('mensajes_procesados')
    .select('id, registros_guardados')
    .eq('usuario_id', usuarioId)
    .eq('mensaje_hash', hash)
    .gte('created_at', limite)
    .limit(1);
  return data && data.length > 0 ? data[0] : null;
}

async function registrarMensajeProcesado(usuarioId, hash, mensajeOriginal, registrosGuardados, status) {
  try {
    await supabase.from('mensajes_procesados').insert([{
      usuario_id: usuarioId,
      mensaje_hash: hash,
      mensaje_original: (mensajeOriginal || '').slice(0, 500),
      registros_guardados: registrosGuardados || 0,
      status: status || 'procesado'
    }]);
  } catch (e) {
    // Falla silenciosa — la idempotencia es protección, no obligación crítica.
    console.error('Error registrando mensaje procesado:', e.message);
  }
}

// ─── VALIDACIÓN ──────────────────────────────────────────────────────────────

const TIPOS_REGISTRO_VALIDOS = ['sueno', 'entrenamiento', 'comida', 'estado', 'sintoma', 'evento'];
const TIPOS_ENTRENO_VALIDOS = ['fuerza', 'cardio', 'mixto', 'movilidad', 'descanso_activo'];
const MOMENTOS_COMIDA_VALIDOS = ['desayuno', 'almuerzo', 'merienda', 'cena', 'snack'];
const REGEX_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const MEDIA_TYPES_VALIDOS = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

function validarRango(valor, min, max) {
  if (valor === null || valor === undefined || valor === '' || valor === ' ') return null;
  const num = Number(valor);
  if (isNaN(num) || num < min || num > max) return null;
  return num;
}

function validarEnum(valor, permitidos) {
  if (!valor || !permitidos.includes(valor)) return null;
  return valor;
}

function validarHora(valor) {
  if (!valor || typeof valor !== 'string') return null;
  return REGEX_HORA.test(valor.trim()) ? valor.trim() : null;
}

function validarFechaEvento(valor) {
  if (!valor) return null;
  try {
    const d = new Date(valor);
    if (isNaN(d.getTime())) return null;
    // Rechazar futuro absurdo (>1 día) y pasado absurdo (>60 días — más allá
    // de eso lo más probable es un error del modelo, no un dato legítimo).
    const ahora = Date.now();
    if (d.getTime() > ahora + 86400000) return null;
    if (d.getTime() < ahora - 60 * 86400000) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

function validarRegistro(obj) {
  const tipo = validarEnum(obj.tipo_registro, TIPOS_REGISTRO_VALIDOS);
  if (!tipo) return null;
  return {
    tipo_registro: tipo,
    fecha_evento: validarFechaEvento(obj.fecha_evento),
    energia: validarRango(obj.energia, 1, 5),
    nota_libre: typeof obj.nota_libre === 'string' ? obj.nota_libre.slice(0, 300) : null,
    sueno_calidad: validarRango(obj.sueno_calidad, 1, 5),
    sueno_duracion_hs: validarRango(obj.sueno_duracion_hs, 0, 24),
    sueno_despertares: validarRango(obj.sueno_despertares, 0, 20),
    sueno_hora_dormir: validarHora(obj.sueno_hora_dormir),
    sueno_hora_despertar: validarHora(obj.sueno_hora_despertar),
    entreno_tipo: validarEnum(obj.entreno_tipo, TIPOS_ENTRENO_VALIDOS),
    entreno_percepcion: validarRango(obj.entreno_percepcion, 1, 5),
    entreno_ayunas: typeof obj.entreno_ayunas === 'boolean' ? obj.entreno_ayunas : null,
    comida_momento: validarEnum(obj.comida_momento, MOMENTOS_COMIDA_VALIDOS),
    comida_descripcion: typeof obj.comida_descripcion === 'string' ? obj.comida_descripcion.slice(0, 500) : null,
    sintoma_tipo: typeof obj.sintoma_tipo === 'string' ? obj.sintoma_tipo.slice(0, 200) : null,
    sintoma_intensidad: validarRango(obj.sintoma_intensidad, 1, 5)
  };
}

// ─── EXTRACCIÓN ──────────────────────────────────────────────────────────────

function construirMapaFechas() {
  // Mapa de los últimos 7 días en zona Argentina, con día de semana correcto.
  const ahora = new Date();
  const mapa = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(ahora);
    d.setDate(d.getDate() - i);
    const fechaStr = d.toLocaleDateString('en-CA', { timeZone: TZ_ARG });
    const diaNombreRaw = d.toLocaleDateString('es-AR', { timeZone: TZ_ARG, weekday: 'long' });
    const diaNombre = diaNombreRaw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const label = i === 0 ? 'hoy' : i === 1 ? 'ayer' : i === 2 ? 'anteayer' : `hace_${i}_dias`;
    mapa.push(`${label}(${diaNombre})=${fechaStr}`);
  }
  return mapa.join(', ');
}

async function extraerRegistros(mensaje, imagenes, estadoOperativo) {
  estadoOperativo = estadoOperativo || '';
  try {
    let contenidoUsuario;
    if (imagenes && imagenes.length > 0) {
      contenidoUsuario = [];
      for (const img of imagenes) {
        contenidoUsuario.push({
          type: 'image',
          source: { type: 'base64', media_type: img.tipo, data: img.base64 }
        });
      }
      contenidoUsuario.push({
        type: 'text',
        text: mensaje && mensaje.trim() ? mensaje : 'Extraé los datos de salud de estas imágenes.'
      });
    } else {
      const ctxTemporal = `[Ahora: ${fechaCompletaArgentina()} | MAPA_FECHAS: ${construirMapaFechas()}]`;
      contenidoUsuario = `${ctxTemporal}\n${estadoOperativo}\n\n${mensaje}`;
    }

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout_extraccion')), 25000)
    );

    const response = await Promise.race([
      anthropic.messages.create({
        model: MODELO,
        max_tokens: 2000,
        system: SABI_EXTRACTOR,
        messages: [{ role: 'user', content: contenidoUsuario }]
      }),
      timeoutPromise
    ]);

    let texto = response.content[0].text.trim();
    texto = texto.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const json = JSON.parse(texto);

    if (!Array.isArray(json.registros)) {
      return {
        registros: [],
        requiereConfirmacionFecha: json.requiere_confirmacion_fecha === true,
        motivoConfirmacion: json.motivo_confirmacion || null,
        error: false
      };
    }

    const validados = json.registros
      .slice(0, 6)
      .map(r => validarRegistro(r))
      .filter(r => r !== null);

    return {
      registros: validados,
      requiereConfirmacionFecha: json.requiere_confirmacion_fecha === true,
      motivoConfirmacion: json.motivo_confirmacion || null,
      error: false
    };
  } catch (error) {
    if (error.message === 'timeout_extraccion') {
      console.error('Timeout en extracción — mensaje demasiado pesado');
      return { registros: [], requiereConfirmacionFecha: false, motivoConfirmacion: null, error: true, timeout: true };
    }
    console.error('Error al extraer:', error.message);
    return { registros: [], requiereConfirmacionFecha: false, motivoConfirmacion: null, error: true };
  }
}

// ─── PERSISTENCIA ────────────────────────────────────────────────────────────

async function guardarRegistros(usuarioId, mensaje, registros) {
  if (!registros || registros.length === 0) return 0;
  const ahora = new Date().toISOString();

  const filas = registros.map(registro => ({
    usuario_id: usuarioId,
    tipo_registro: registro.tipo_registro,
    fecha_evento: registro.fecha_evento || ahora,
    mensaje_original: mensaje || '[imagen]',
    origen: 'chat',
    energia: registro.energia,
    nota_libre: registro.nota_libre,
    sueno_calidad: registro.sueno_calidad,
    sueno_duracion_hs: registro.sueno_duracion_hs,
    sueno_despertares: registro.sueno_despertares,
    sueno_hora_dormir: registro.sueno_hora_dormir,
    sueno_hora_despertar: registro.sueno_hora_despertar,
    entreno_tipo: registro.entreno_tipo,
    entreno_percepcion: registro.entreno_percepcion,
    entreno_ayunas: registro.entreno_ayunas,
    comida_momento: registro.comida_momento,
    comida_descripcion: registro.comida_descripcion,
    sintoma_tipo: registro.sintoma_tipo,
    sintoma_intensidad: registro.sintoma_intensidad
  }));

  const { error, data } = await supabase.from('registros').insert(filas).select('id');
  if (error) {
    console.error('Error en batch insert de registros:', error.message);
    return 0;
  }
  return data ? data.length : filas.length;
}

// Resumen humano de los registros guardados para inyectar al system.
// Reemplaza el JSON dump que hacía que el modelo "leyera de vuelta" los datos.
function resumirRegistrosGuardados(registros) {
  if (!registros || registros.length === 0) return null;
  const partes = registros.map(r => {
    if (r.tipo_registro === 'sueno') {
      const partesSueno = [];
      if (r.sueno_duracion_hs) partesSueno.push(`${r.sueno_duracion_hs}hs`);
      if (r.sueno_calidad) partesSueno.push(`calidad ${r.sueno_calidad}/5`);
      return `sueño${partesSueno.length ? ' (' + partesSueno.join(', ') + ')' : ''}`;
    }
    if (r.tipo_registro === 'entrenamiento') return `entrenamiento${r.entreno_tipo ? ' ' + r.entreno_tipo : ''}`;
    if (r.tipo_registro === 'comida') return r.comida_momento || 'comida';
    if (r.tipo_registro === 'estado') return r.energia ? `energía ${r.energia}/5` : 'estado del día';
    if (r.tipo_registro === 'sintoma') return `síntoma: ${r.sintoma_tipo || 'sin especificar'}`;
    return r.tipo_registro;
  });
  return partes.join(', ');
}

// ─── MADUREZ ─────────────────────────────────────────────────────────────────

async function actualizarMadurez(usuarioId) {
  try {
    const { data: registros } = await supabase
      .from('registros')
      .select('fecha_evento, created_at')
      .eq('usuario_id', usuarioId);

    if (!registros) return;

    const cantidadRegistros = registros.length;
    const diasConDatos = new Set(
      registros.map(r => fechaArgentinaYMD(new Date(r.fecha_evento || r.created_at)))
    ).size;

    let nuevaMadurez = 'escucha';
    if (diasConDatos >= 31 && cantidadRegistros >= 50) nuevaMadurez = 'profundo';
    else if (diasConDatos >= 15 && cantidadRegistros >= 25) nuevaMadurez = 'patron_confirmado';
    else if (diasConDatos >= 8 && cantidadRegistros >= 10) nuevaMadurez = 'tendencia_temprana';

    await supabase
      .from('estado_usuario')
      .update({ madurez_sabi: nuevaMadurez, cantidad_registros: cantidadRegistros, dias_con_datos: diasConDatos })
      .eq('usuario_id', usuarioId);
  } catch (error) {
    console.error('Error actualizando madurez:', error.message);
  }
}

// ─── FEEDBACK DE INSIGHTS ────────────────────────────────────────────────────

async function clasificarFeedbackInsight(mensajeUsuario, insight) {
  try {
    const prompt = `INSIGHT COMUNICADO AL USUARIO:
Tipo: ${insight.tipo_insight}
Regla: ${insight.regla_origen}

RESPUESTA DEL USUARIO:
"${mensajeUsuario}"

Clasificá la respuesta.`;

    const response = await anthropic.messages.create({
      model: MODELO,
      max_tokens: 200,
      system: PROMPT_CLASIFICADOR_INSIGHT,
      messages: [{ role: 'user', content: prompt }]
    });

    let texto = response.content[0].text.trim();
    texto = texto.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const resultado = JSON.parse(texto);

    const ahora = new Date().toISOString();
    let nuevoEstado = insight.estado;
    let nuevaConfianza = insight.confianza;

    switch (resultado.clasificacion) {
      case 'valida':
        nuevoEstado = 'comunicado';
        nuevaConfianza = 'confirmado';
        break;
      case 'niega':
        nuevoEstado = 'descartado';
        nuevaConfianza = 'descartado';
        break;
      case 'valida_parcial':
      case 'propone_alternativa':
      case 'ambigua':
        nuevoEstado = 'comunicado';
        nuevaConfianza = 'tentativo';
        break;
      case 'no_relacionado':
        return;
    }

    const evidenciaActualizada = {
      ...(insight.evidencia_json || {}),
      feedback_usuario: {
        clasificacion: resultado.clasificacion,
        resumen: resultado.resumen_respuesta_usuario,
        hipotesis_alternativa: resultado.hipotesis_alternativa || null,
        fecha: ahora
      }
    };

    await supabase
      .from('insights')
      .update({
        estado: nuevoEstado,
        confianza: nuevaConfianza,
        evidencia_json: evidenciaActualizada,
        fecha_validacion: ahora
      })
      .eq('id', insight.id);

    console.log(`Insight ${insight.id}: ${resultado.clasificacion} → ${nuevoEstado}`);
  } catch (error) {
    console.error('Error clasificando feedback de insight:', error.message);
  }
}

async function detectarYClasificarFeedback(usuarioId, mensajeUsuario) {
  try {
    const { data: estadoU } = await supabase
      .from('estado_usuario')
      .select('ultimo_insight_mostrado_id, ultimo_insight_mostrado_at')
      .eq('usuario_id', usuarioId)
      .single();

    if (!estadoU || !estadoU.ultimo_insight_mostrado_id) return;

    if (estadoU.ultimo_insight_mostrado_at) {
      const hace24h = new Date();
      hace24h.setHours(hace24h.getHours() - 24);
      if (new Date(estadoU.ultimo_insight_mostrado_at) < hace24h) return;
    }

    const { data: insight } = await supabase
      .from('insights')
      .select('id, tipo_insight, regla_origen, confianza, estado, evidencia_json')
      .eq('id', estadoU.ultimo_insight_mostrado_id)
      .in('estado', ['pendiente', 'comunicado'])
      .single();

    if (!insight) return;

    // Segundo plano — no bloquea respuesta al usuario
    clasificarFeedbackInsight(mensajeUsuario, insight).catch(e =>
      console.error('Clasificador insight background error:', e.message)
    );
  } catch (error) {
    console.error('Error en detectarYClasificarFeedback:', error.message);
  }
}

// ─── SEÑALES (INSIGHTS) ──────────────────────────────────────────────────────

async function insightExiste(usuarioId, tipoInsight, reglaOrigen) {
  const hace14dias = new Date();
  hace14dias.setDate(hace14dias.getDate() - 14);
  const { data } = await supabase
    .from('insights')
    .select('id')
    .eq('usuario_id', usuarioId)
    .eq('tipo_insight', tipoInsight)
    .eq('regla_origen', reglaOrigen)
    .in('estado', ['pendiente', 'comunicado'])
    .gte('created_at', hace14dias.toISOString())
    .limit(1);
  return data && data.length > 0;
}

async function crearInsight(usuarioId, tipoInsight, reglaOrigen, evidencia) {
  if (await insightExiste(usuarioId, tipoInsight, reglaOrigen)) return;
  const { error } = await supabase.from('insights').insert([{
    usuario_id: usuarioId,
    tipo_insight: tipoInsight,
    regla_origen: reglaOrigen,
    evidencia_json: evidencia,
    confianza: 'tentativo',
    estado: 'pendiente'
  }]);
  if (error) console.error('Error creando insight:', error.message);
  else console.log(`Insight creado: ${tipoInsight} / ${reglaOrigen}`);
}

async function evaluarSenales(usuarioId) {
  const hace7dias = new Date();
  hace7dias.setDate(hace7dias.getDate() - 7);

  const { data: registros } = await supabase
    .from('registros')
    .select('tipo_registro, energia, sueno_calidad, fecha_evento, created_at')
    .eq('usuario_id', usuarioId);

  if (!registros || registros.length === 0) return;

  const recientes = registros
    .map(r => ({ ...r, fecha_ref: new Date(r.fecha_evento || r.created_at) }))
    .filter(r => r.fecha_ref >= hace7dias);

  if (recientes.length === 0) return;

  const suenoBajo = recientes.filter(r =>
    r.tipo_registro === 'sueno' && r.sueno_calidad !== null && r.sueno_calidad <= 2
  );
  if (suenoBajo.length >= 3) {
    await crearInsight(usuarioId, 'sueno_recuperacion', 'sueno_bajo_repetido_7d', {
      dias_analizados: 7, registros_sueno_bajo: suenoBajo.length, umbral: 2
    });
  }

  const diasConEnergiaBaja = new Set();
  recientes.forEach(r => {
    if (r.energia !== null && r.energia <= 2) {
      diasConEnergiaBaja.add(fechaArgentinaYMD(r.fecha_ref));
    }
  });
  if (diasConEnergiaBaja.size >= 3) {
    await crearInsight(usuarioId, 'energia_sostenida', 'energia_baja_repetida_7d', {
      dias_analizados: 7, dias_con_energia_baja: diasConEnergiaBaja.size, umbral: 2
    });
  }

  // Correlación sueño → energía usando día calendario Argentina
  const registrosPorDia = {};
  recientes.forEach(r => {
    const dia = fechaArgentinaYMD(r.fecha_ref);
    if (!registrosPorDia[dia]) registrosPorDia[dia] = [];
    registrosPorDia[dia].push(r);
  });

  let correlaciones = 0;
  Object.keys(registrosPorDia).forEach(dia => {
    const regsDia = registrosPorDia[dia];
    const tieneSuenoBajo = regsDia.some(r =>
      r.tipo_registro === 'sueno' && r.sueno_calidad !== null && r.sueno_calidad <= 2
    );
    if (tieneSuenoBajo) {
      const diaSiguienteDate = new Date(dia + 'T12:00:00-03:00');
      diaSiguienteDate.setDate(diaSiguienteDate.getDate() + 1);
      const diaSiguienteStr = fechaArgentinaYMD(diaSiguienteDate);
      const regsSiguiente = registrosPorDia[diaSiguienteStr] || [];

      const energiaBaja = [...regsDia, ...regsSiguiente].some(r =>
        r.energia !== null && r.energia <= 2
      );
      if (energiaBaja) correlaciones++;
    }
  });
  if (correlaciones >= 2) {
    await crearInsight(usuarioId, 'sueno_energia', 'sueno_bajo_energia_baja_7d', {
      dias_analizados: 7, correlaciones_detectadas: correlaciones
    });
  }
}

// ─── CONTEXTO RECIENTE ───────────────────────────────────────────────────────

async function armarContextoReciente(usuarioId) {
  const hace7dias = new Date();
  hace7dias.setDate(hace7dias.getDate() - 7);

  const { data: todos } = await supabase
    .from('registros')
    .select('*')
    .eq('usuario_id', usuarioId);

  if (!todos || todos.length === 0) return null;

  const registros = todos.filter(r => new Date(r.fecha_evento || r.created_at) >= hace7dias);
  if (registros.length === 0) return null;

  let contexto = 'CONTEXTO RECIENTE (últimos 7 días):\n';

  const suenos = registros.filter(r => r.tipo_registro === 'sueno');
  if (suenos.length > 0) {
    const calidades = suenos.filter(r => r.sueno_calidad !== null).map(r => r.sueno_calidad);
    const duraciones = suenos.filter(r => r.sueno_duracion_hs !== null).map(r => r.sueno_duracion_hs);
    const nochesbajas = calidades.filter(c => c <= 2).length;
    const promCalidad = calidades.length > 0 ? (calidades.reduce((a, b) => a + b, 0) / calidades.length).toFixed(1) : null;
    const promDuracion = duraciones.length > 0 ? (duraciones.reduce((a, b) => a + b, 0) / duraciones.length).toFixed(1) : null;
    contexto += `Sueño:\n- registros: ${suenos.length}\n`;
    if (promCalidad) contexto += `- calidad promedio: ${promCalidad}/5\n`;
    if (promDuracion) contexto += `- duración promedio: ${promDuracion}hs\n`;
    if (nochesbajas > 0) contexto += `- noches con calidad baja (<=2): ${nochesbajas}\n`;
  }

  const diasConEnergia = {};
  registros.forEach(r => {
    if (r.energia !== null) {
      const dia = fechaArgentinaYMD(new Date(r.fecha_evento || r.created_at));
      if (!diasConEnergia[dia] || r.energia < diasConEnergia[dia]) diasConEnergia[dia] = r.energia;
    }
  });
  const valoresEnergia = Object.values(diasConEnergia);
  if (valoresEnergia.length > 0) {
    const promEnergia = (valoresEnergia.reduce((a, b) => a + b, 0) / valoresEnergia.length).toFixed(1);
    const diasBajos = valoresEnergia.filter(e => e <= 2).length;
    const tendencia = diasBajos >= 3 ? 'baja repetida' : diasBajos >= 1 ? 'variable' : 'estable';
    contexto += `Energía:\n- días registrados: ${valoresEnergia.length}\n- promedio: ${promEnergia}/5\n- tendencia: ${tendencia}\n`;
    if (diasBajos > 0) contexto += `- días bajos (<=2): ${diasBajos}\n`;
  }

  const entrenos = registros.filter(r => r.tipo_registro === 'entrenamiento');
  if (entrenos.length > 0) {
    const fuerza = entrenos.filter(r => r.entreno_tipo === 'fuerza').length;
    const cardio = entrenos.filter(r => r.entreno_tipo === 'cardio').length;
    const movilidad = entrenos.filter(r => r.entreno_tipo === 'movilidad').length;
    const descActivo = entrenos.filter(r => r.entreno_tipo === 'descanso_activo').length;
    const ayunas = entrenos.filter(r => r.entreno_ayunas === true).length;
    contexto += `Entrenamiento:\n- sesiones totales: ${entrenos.length}\n`;
    if (fuerza > 0) contexto += `- fuerza: ${fuerza}\n`;
    if (cardio > 0) contexto += `- cardio: ${cardio}\n`;
    if (movilidad > 0) contexto += `- movilidad: ${movilidad}\n`;
    if (descActivo > 0) contexto += `- descanso activo: ${descActivo}\n`;
    if (ayunas > 0) contexto += `- en ayunas: ${ayunas}\n`;
  }

  const comidas = registros.filter(r => r.tipo_registro === 'comida');
  if (comidas.length > 0) {
    const almuerzos = comidas.filter(r => r.comida_momento === 'almuerzo').length;
    const meriendas = comidas.filter(r => r.comida_momento === 'merienda').length;
    const cenas = comidas.filter(r => r.comida_momento === 'cena').length;
    contexto += `Alimentación:\n- registros totales: ${comidas.length}\n`;
    if (almuerzos > 0) contexto += `- almuerzos: ${almuerzos}\n`;
    if (meriendas > 0) contexto += `- meriendas: ${meriendas}\n`;
    if (cenas > 0) contexto += `- cenas: ${cenas}\n`;
  }

  const sintomas = registros.filter(r => r.tipo_registro === 'sintoma');
  if (sintomas.length > 0) {
    const tiposUnicos = [...new Set(sintomas.filter(r => r.sintoma_tipo).map(r => r.sintoma_tipo))];
    const intensidades = sintomas.filter(r => r.sintoma_intensidad !== null).map(r => r.sintoma_intensidad);
    contexto += `Síntomas:\n- registros: ${sintomas.length}\n`;
    if (tiposUnicos.length > 0) contexto += `- tipos: ${tiposUnicos.join(', ')}\n`;
    // Math.max defensivo — solo si hay al menos un valor
    if (intensidades.length > 0) contexto += `- intensidad máxima: ${Math.max(...intensidades)}/5\n`;
  }

  return contexto;
}

// ─── ESTADO DEL DÍA ──────────────────────────────────────────────────────────
// Esto es la fuente de verdad sobre "qué pasó hoy y qué sigue".
// Se le pasa al modelo SOLO lo que informa decisión: qué momentos están
// registrados (los que el código usa para decidir si preguntar), si el día
// está cerrado, y cuál es el próximo momento habilitado.
//
// Se removieron: "Entrenamiento registrado", "Energía registrada",
// "Síntomas registrados", "Último registro". Estos campos hacían que el
// modelo preguntara cosas que el código no quería que preguntara.

async function armarEstadoDia(usuarioId) {
  const inicioHoy = inicioHoyArgentina();
  const inicioManana = inicioMananaArgentina();

  const { data: todos } = await supabase
    .from('registros')
    .select('tipo_registro, comida_momento, fecha_evento, created_at')
    .eq('usuario_id', usuarioId);

  const registrosHoy = (todos || []).filter(r => {
    const fechaRef = new Date(r.fecha_evento || r.created_at);
    return fechaRef >= inicioHoy && fechaRef < inicioManana;
  });

  const sueno = registrosHoy.some(r => r.tipo_registro === 'sueno');
  const almuerzo = registrosHoy.some(r => r.tipo_registro === 'comida' && r.comida_momento === 'almuerzo');
  const merienda = registrosHoy.some(r => r.tipo_registro === 'comida' && r.comida_momento === 'merienda');
  const cena = registrosHoy.some(r => r.tipo_registro === 'comida' && r.comida_momento === 'cena');

  const horaActual = horaActualArgentina();
  const diaCerrado = cena;

  // Ventanas horarias:
  //   <12:00          → sueño (si no se registró)
  //   12:00–15:59     → almuerzo
  //   16:00–19:59     → merienda
  //   ≥20:00          → cena
  // Entrenamiento NO tiene ventana automática — cada uno entrena en su momento.
  let proximoMomento = null;
  if (!diaCerrado) {
    if (horaActual < 12 && !sueno) proximoMomento = 'sueno';
    else if (horaActual >= 12 && horaActual < 16 && !almuerzo) proximoMomento = 'almuerzo';
    else if (horaActual >= 16 && horaActual < 20 && !merienda) proximoMomento = 'merienda';
    else if (horaActual >= 20 && !cena) proximoMomento = 'cena';
  }

  const puedePreguntar = proximoMomento !== null;
  const accionRecomendada = diaCerrado ? 'dia_cerrado'
    : !puedePreguntar ? 'cerrar_breve'
    : 'preguntar_proximo';

  const condicionCheckin = cena && horaActual >= 20;

  const fecha = fechaArgentinaYMD();
  let estadoTexto = `ESTADO DEL DÍA (${fecha}):\n`;
  estadoTexto += `Hora actual: ${horaActual}:00 (Argentina)\n`;
  estadoTexto += `Sueño de hoy registrado: ${sueno ? 'sí' : 'no'}\n`;
  estadoTexto += `Almuerzo registrado: ${almuerzo ? 'sí' : 'no'}\n`;
  estadoTexto += `Merienda registrada: ${merienda ? 'sí' : 'no'}\n`;
  estadoTexto += `Cena registrada: ${cena ? 'sí' : 'no'}\n`;
  estadoTexto += `Día cerrado: ${diaCerrado ? 'sí' : 'no'}\n`;
  estadoTexto += `Próximo momento habilitado: ${proximoMomento || 'ninguno'}\n`;
  estadoTexto += `Puede preguntar: ${puedePreguntar ? 'sí' : 'no'}\n`;
  estadoTexto += `Acción recomendada: ${accionRecomendada}\n`;
  estadoTexto += `\nREGLA: `;
  if (diaCerrado) {
    estadoTexto += `El día está cerrado. Terminá con algo cálido y breve. Sin preguntas bajo ninguna circunstancia.`;
  } else if (!puedePreguntar) {
    estadoTexto += `No hay próximo momento habilitado. Respondé sin hacer preguntas sobre el día.`;
  } else {
    estadoTexto += `Si vas a preguntar algo, que sea SOLO sobre "${proximoMomento}". Una sola pregunta.`;
  }

  return {
    texto: estadoTexto,
    condicionCheckin,
    puedePreguntar,
    accionRecomendada,
    proximoMomento,
    diaCerrado
  };
}

// ─── RESPUESTA CON IMÁGENES ──────────────────────────────────────────────────

async function generarRespuestaConImagenes(systemFinal, mensajesPrevios, mensaje, imagenes) {
  const contenidoImagen = [];
  for (const img of imagenes) {
    contenidoImagen.push({
      type: 'image',
      source: { type: 'base64', media_type: img.tipo, data: img.base64 }
    });
  }
  contenidoImagen.push({
    type: 'text',
    text: mensaje && mensaje.trim() ? mensaje : 'Mirá estas imágenes y respondé como Sabi.'
  });

  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout_imagen')), 30000)
    );

    const response = await Promise.race([
      anthropic.messages.create({
        model: MODELO,
        max_tokens: 500,
        system: systemFinal,
        messages: [...mensajesPrevios.slice(0, -1), { role: 'user', content: contenidoImagen }],
      }),
      timeoutPromise
    ]);
    return response;
  } catch (error) {
    if (error.message === 'timeout_imagen') {
      console.error('Timeout procesando imagen — respondiendo sin imagen');
      return await anthropic.messages.create({
        model: MODELO,
        max_tokens: 500,
        system: systemFinal + '\n\nADVERTENCIA: No se pudo procesar la imagen adjunta. Respondé al mensaje de texto e informale al usuario que no pudiste leer la imagen — pedile que la reenvíe sola o en mejor calidad.',
        messages: mensajesPrevios,
      });
    }
    throw error;
  }
}

// ─── RESUMEN SEMANAL ─────────────────────────────────────────────────────────

async function generarResumenSemanal(usuarioId) {
  const hace7dias = new Date();
  hace7dias.setDate(hace7dias.getDate() - 7);

  const { data: todos } = await supabase
    .from('registros')
    .select('*')
    .eq('usuario_id', usuarioId);

  const registros = (todos || []).filter(r => new Date(r.fecha_evento || r.created_at) >= hace7dias);

  const { data: user } = await supabase
    .from('usuarios')
    .select('nombre, contexto_base')
    .eq('id', usuarioId)
    .single();

  const { data: estado } = await supabase
    .from('estado_usuario')
    .select('madurez_sabi')
    .eq('usuario_id', usuarioId)
    .single();

  const diasConDatosEstaSemana = new Set(
    registros.map(r => fechaArgentinaYMD(new Date(r.fecha_evento || r.created_at)))
  ).size;

  if (diasConDatosEstaSemana < 3) {
    return 'Esta semana todavía tengo pocos datos para hacer un resumen útil. Lo más honesto es seguir acumulando registros unos días más.';
  }

  const suenos = registros.filter(r => r.tipo_registro === 'sueno');
  const entrenos = registros.filter(r => r.tipo_registro === 'entrenamiento');
  const comidas = registros.filter(r => r.tipo_registro === 'comida');
  const estados = registros.filter(r => r.tipo_registro === 'estado');
  const sintomas = registros.filter(r => r.tipo_registro === 'sintoma');

  let datosResumen = 'DATOS DE LA SEMANA (últimos 7 días):\n\n';

  if (suenos.length > 0) {
    const calidades = suenos.filter(r => r.sueno_calidad !== null).map(r => r.sueno_calidad);
    const duraciones = suenos.filter(r => r.sueno_duracion_hs !== null).map(r => r.sueno_duracion_hs);
    const promCalidad = calidades.length > 0 ? (calidades.reduce((a, b) => a + b, 0) / calidades.length).toFixed(1) : null;
    const promDuracion = duraciones.length > 0 ? (duraciones.reduce((a, b) => a + b, 0) / duraciones.length).toFixed(1) : null;
    const nochesbajas = calidades.filter(c => c <= 2).length;
    datosResumen += `SUEÑO: ${suenos.length} noches registradas.`;
    if (promCalidad) datosResumen += ` Calidad promedio ${promCalidad}/5.`;
    if (promDuracion) datosResumen += ` Duración promedio ${promDuracion}hs.`;
    if (nochesbajas > 0) datosResumen += ` Noches bajas (<=2): ${nochesbajas}.`;
    const notasSueno = suenos.filter(r => r.nota_libre).map(r => r.nota_libre).join(' | ');
    if (notasSueno) datosResumen += ` Notas: ${notasSueno}`;
    datosResumen += '\n\n';
  } else {
    datosResumen += 'SUEÑO: sin registros esta semana.\n\n';
  }

  if (entrenos.length > 0) {
    const fuerza = entrenos.filter(r => r.entreno_tipo === 'fuerza').length;
    const cardio = entrenos.filter(r => r.entreno_tipo === 'cardio').length;
    const ayunas = entrenos.filter(r => r.entreno_ayunas === true).length;
    datosResumen += `ENTRENAMIENTO: ${entrenos.length} sesiones.`;
    if (fuerza) datosResumen += ` Fuerza: ${fuerza}.`;
    if (cardio) datosResumen += ` Cardio: ${cardio}.`;
    if (ayunas) datosResumen += ` En ayunas: ${ayunas}.`;
    datosResumen += '\n\n';
  } else {
    datosResumen += 'ENTRENAMIENTO: sin registros esta semana.\n\n';
  }

  if (comidas.length > 0) {
    const almuerzos = comidas.filter(r => r.comida_momento === 'almuerzo').length;
    const meriendas = comidas.filter(r => r.comida_momento === 'merienda').length;
    const cenas = comidas.filter(r => r.comida_momento === 'cena').length;
    datosResumen += `ALIMENTACIÓN: ${comidas.length} registros. Almuerzos: ${almuerzos}, meriendas: ${meriendas}, cenas: ${cenas}.\n\n`;
  }

  if (estados.length > 0) {
    const energias = estados.filter(r => r.energia !== null).map(r => r.energia);
    const promEnergia = energias.length > 0 ? (energias.reduce((a, b) => a + b, 0) / energias.length).toFixed(1) : null;
    datosResumen += `ENERGÍA: ${estados.length} registros.`;
    if (promEnergia) datosResumen += ` Promedio ${promEnergia}/5.`;
    datosResumen += '\n\n';
  }

  if (sintomas.length > 0) {
    const tiposUnicos = [...new Set(sintomas.filter(r => r.sintoma_tipo).map(r => r.sintoma_tipo))];
    datosResumen += `SÍNTOMAS: ${sintomas.length} registro/s. Tipos: ${tiposUnicos.join(', ')}.\n\n`;
  }

  datosResumen += `DÍAS CON DATOS ESTA SEMANA: ${diasConDatosEstaSemana}\n`;
  datosResumen += `MADUREZ DEL SISTEMA: ${estado?.madurez_sabi || 'escucha'}\n`;

  const promptResumen = `Generá el resumen semanal de salud para ${user?.nombre || 'el usuario'}.

PERFIL BASE:
${user?.contexto_base || 'Sin perfil disponible'}

${datosResumen}

Estructura en prosa continua:
1. Una observación sobre sueño
2. Una observación sobre movimiento y recuperación
3. Una observación sobre nutrición o energía
4. El patrón más interesante de la semana — conexión entre pilares
5. Una sola sugerencia concreta para la semana siguiente`;

  const response = await anthropic.messages.create({
    model: MODELO,
    max_tokens: 600,
    system: SABI_RESUMEN_SYSTEM,
    messages: [{ role: 'user', content: promptResumen }]
  });

  return response.content[0].text;
}

// ─── HÁBITOS ─────────────────────────────────────────────────────────────────

const HABITOS_FRECUENTES = [
  'entreno_ayunas_recurrente', 'fuerza_alta_adherencia', 'sueno_consistente',
  'sueno_irregular', 'cena_tardia_recurrente',
  'energia_baja_lunes', 'energia_baja_martes', 'energia_baja_miercoles',
  'energia_baja_jueves', 'energia_baja_viernes', 'energia_baja_sabado', 'energia_baja_domingo'
];

const DIAS_SEMANA_SIN_ACENTOS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

async function habitoExiste(usuarioId, tipoHabito) {
  const { data } = await supabase
    .from('habitos_usuario')
    .select('id, estado, confianza, evidencia_json, cantidad_reactivaciones, primera_deteccion')
    .eq('usuario_id', usuarioId)
    .eq('tipo_habito', tipoHabito)
    .in('estado', ['activo', 'inactivo', 'reactivado'])
    .order('ultima_actualizacion', { ascending: false })
    .limit(1);
  return data && data.length > 0 ? data[0] : null;
}

async function upsertHabito(usuarioId, tipoHabito, descripcion, evidencia) {
  const existente = await habitoExiste(usuarioId, tipoHabito);
  const ahora = new Date().toISOString();

  if (existente) {
    if (existente.estado === 'inactivo') {
      const reactivaciones = (existente.cantidad_reactivaciones || 0) + 1;
      await supabase
        .from('habitos_usuario')
        .update({
          estado: 'reactivado',
          descripcion,
          evidencia_json: evidencia,
          ultima_actualizacion: ahora,
          ultima_reactivacion: ahora,
          cantidad_reactivaciones: reactivaciones,
          motivo_inactivacion: null
        })
        .eq('id', existente.id);
      console.log(`Hábito reactivado: ${tipoHabito} (reactivación #${reactivaciones})`);
    } else {
      await supabase
        .from('habitos_usuario')
        .update({ descripcion, evidencia_json: evidencia, ultima_actualizacion: ahora })
        .eq('id', existente.id);
    }
  } else {
    await supabase.from('habitos_usuario').insert([{
      usuario_id: usuarioId,
      tipo_habito: tipoHabito,
      descripcion,
      confianza: 'tentativo',
      evidencia_json: evidencia,
      estado: 'activo',
      primera_deteccion: ahora,
      ultima_actualizacion: ahora,
      cantidad_reactivaciones: 0
    }]);
    console.log(`Hábito detectado: ${tipoHabito}`);
  }
}

async function inactivarHabitosVencidos(usuarioId) {
  try {
    const hace14dias = new Date();
    hace14dias.setDate(hace14dias.getDate() - 14);

    const { data: habitos } = await supabase
      .from('habitos_usuario')
      .select('id, tipo_habito, ultima_actualizacion')
      .eq('usuario_id', usuarioId)
      .in('estado', ['activo', 'reactivado'])
      .in('tipo_habito', HABITOS_FRECUENTES);

    if (!habitos || habitos.length === 0) return;

    for (const h of habitos) {
      if (new Date(h.ultima_actualizacion) < hace14dias) {
        await supabase
          .from('habitos_usuario')
          .update({
            estado: 'inactivo',
            motivo_inactivacion: 'sin_deteccion_14_dias',
            ultima_actualizacion: new Date().toISOString()
          })
          .eq('id', h.id);
        console.log(`Hábito inactivado: ${h.tipo_habito}`);
      }
    }
  } catch (error) {
    console.error('Error inactivando hábitos:', error.message);
  }
}

async function detectarHabitos(usuarioId) {
  try {
    const hace30dias = new Date();
    hace30dias.setDate(hace30dias.getDate() - 30);

    const { data: todos } = await supabase
      .from('registros')
      .select('tipo_registro, fecha_evento, created_at, entreno_ayunas, entreno_tipo, comida_momento, sueno_calidad, sueno_duracion_hs, energia, nota_libre')
      .eq('usuario_id', usuarioId);

    if (!todos || todos.length === 0) return;

    const registros = todos.filter(r => new Date(r.fecha_evento || r.created_at) >= hace30dias);
    if (registros.length < 10) return;

    const entrenos = registros.filter(r => r.tipo_registro === 'entrenamiento');
    const suenos = registros.filter(r => r.tipo_registro === 'sueno');
    const comidas = registros.filter(r => r.tipo_registro === 'comida');

    // ── Entrena en ayunas ─────────────────────────────────────────────────
    if (entrenos.length >= 5) {
      const enAyunas = entrenos.filter(r => r.entreno_ayunas === true);
      const porc = enAyunas.length / entrenos.length;
      if (porc >= 0.6) {
        await upsertHabito(usuarioId, 'entreno_ayunas_recurrente',
          `Entrena en ayunas en el ${Math.round(porc * 100)}% de las sesiones registradas.`,
          { sesiones_totales: entrenos.length, sesiones_ayunas: enAyunas.length, porcentaje: porc }
        );
      }
    }

    // ── Alta adherencia a fuerza (usando semana calendario Argentina) ─────
    if (entrenos.length >= 5) {
      const fuerza = entrenos.filter(r => r.entreno_tipo === 'fuerza');
      if (fuerza.length >= 3) {
        const semanas = new Set(fuerza.map(r => {
          const fechaArg = fechaArgentinaYMD(new Date(r.fecha_evento || r.created_at));
          const dMediodia = new Date(fechaArg + 'T12:00:00-03:00');
          const dia = dMediodia.getDay();
          dMediodia.setDate(dMediodia.getDate() - dia);
          return fechaArgentinaYMD(dMediodia);
        }));
        if (semanas.size >= 2) {
          await upsertHabito(usuarioId, 'fuerza_alta_adherencia',
            `Entrena fuerza de forma consistente — ${fuerza.length} sesiones en las últimas semanas.`,
            { sesiones_fuerza: fuerza.length, semanas_activas: semanas.size }
          );
        }
      }
    }

    // ── Sueño consistente ─────────────────────────────────────────────────
    if (suenos.length >= 5) {
      const calidades = suenos.filter(r => r.sueno_calidad !== null).map(r => r.sueno_calidad);
      const buenas = calidades.filter(c => c >= 4).length;
      if (calidades.length >= 5 && buenas / calidades.length >= 0.7) {
        await upsertHabito(usuarioId, 'sueno_consistente',
          `El sueño es consistentemente bueno — calidad >= 4 en el ${Math.round(buenas / calidades.length * 100)}% de las noches registradas.`,
          { noches_registradas: calidades.length, noches_buenas: buenas }
        );
      }
    }

    // ── Sueño irregular ───────────────────────────────────────────────────
    if (suenos.length >= 5) {
      const calidades = suenos.filter(r => r.sueno_calidad !== null).map(r => r.sueno_calidad);
      const bajas = calidades.filter(c => c <= 2).length;
      if (calidades.length >= 5 && bajas / calidades.length >= 0.4) {
        await upsertHabito(usuarioId, 'sueno_irregular',
          `El sueño muestra irregularidad frecuente — calidad baja en el ${Math.round(bajas / calidades.length * 100)}% de las noches registradas.`,
          { noches_registradas: calidades.length, noches_bajas: bajas }
        );
      }
    }

    // ── Cena tardía recurrente ────────────────────────────────────────────
    const cenas = comidas.filter(r => r.comida_momento === 'cena' && r.nota_libre);
    if (cenas.length >= 3) {
      const cenasTardias = cenas.filter(r => {
        const m = r.nota_libre?.match(/(\d{1,2}):(\d{2})/);
        return m ? parseInt(m[1]) >= 21 : false;
      });
      if (cenasTardias.length / cenas.length >= 0.5) {
        await upsertHabito(usuarioId, 'cena_tardia_recurrente',
          `Cena frecuentemente después de las 21hs — en el ${Math.round(cenasTardias.length / cenas.length * 100)}% de los registros.`,
          { cenas_registradas: cenas.length, cenas_tardias: cenasTardias.length }
        );
      }
    }

    // ── Energía baja en día específico (con día calculado en zona ARG) ────
    const registrosEnergia = registros.filter(r => r.energia !== null && r.energia <= 2);
    if (registrosEnergia.length >= 4) {
      const conteoXDia = {};
      registrosEnergia.forEach(r => {
        const dia = diaSemanaArgentina(new Date(r.fecha_evento || r.created_at));
        conteoXDia[dia] = (conteoXDia[dia] || 0) + 1;
      });
      for (const [diaIdx, count] of Object.entries(conteoXDia)) {
        if (count >= 2) {
          const nombreDia = DIAS_SEMANA_SIN_ACENTOS[diaIdx];
          await upsertHabito(usuarioId, `energia_baja_${nombreDia}`,
            `Energía baja se repite los ${nombreDia} — detectado ${count} veces en los últimos 30 días.`,
            { dia_semana: nombreDia, ocurrencias: count }
          );
        }
      }
    }
  } catch (error) {
    console.error('Error detectando hábitos:', error.message);
  }
}

async function armarContextoHabitos(usuarioId) {
  const { data: habitos } = await supabase
    .from('habitos_usuario')
    .select('tipo_habito, descripcion, confianza, ultima_actualizacion')
    .eq('usuario_id', usuarioId)
    .in('estado', ['activo', 'reactivado'])
    .neq('confianza', 'descartado')
    .order('ultima_actualizacion', { ascending: false })
    .limit(8);

  if (!habitos || habitos.length === 0) return null;

  let texto = 'HÁBITOS DETECTADOS (patrones consolidados de esta persona):\n';
  habitos.forEach(h => {
    texto += `- ${h.descripcion} (confianza: ${h.confianza})\n`;
  });
  texto += 'Usá estos hábitos para personalizar observaciones y anticipar comportamientos — no para prescribir.';
  return texto;
}

// ─── OBRA SOCIAL ─────────────────────────────────────────────────────────────

function esMensajeObraSocial(mensaje) {
  if (!mensaje) return false;
  const keywords = [
    'cubre', 'cobertura', 'obra social', 'pami', 'osseg', 'osde', 'ioma', 'prepaga',
    'prestador', 'médico', 'medico', 'especialista', 'farmacia', 'farmac',
    'turno', 'autorización', 'autorizacion', 'receta', 'medicamento', 'remedios',
    'laboratorio', 'análisis', 'ecografía', 'estudio', 'tomografía',
    'oftalmólogo', 'cardiólogo', 'traumatólogo', 'clínica', 'sanatorio',
    'internación', 'guardia', 'urgencia', 'traslado', 'ambulancia',
    'óptica', 'anteojos', 'audífono', 'prótesis', 'kinesiología',
    'porcentaje', 'reintegro', 'plan', 'afiliado', 'cartilla',
    'quién me atiende', 'donde me atiendo', 'dónde', 'donde'
  ];
  const msj = mensaje.toLowerCase();
  return keywords.some(k => msj.includes(k));
}

function extraerObraSocial(contextoBase) {
  if (!contextoBase) return null;
  const ctx = contextoBase.toUpperCase();
  if (ctx.includes('PAMI')) return 'PAMI';
  if (ctx.includes('OSSEG')) return 'OSSEG';
  if (ctx.includes('OSDE')) return 'OSDE';
  if (ctx.includes('IOMA')) return 'IOMA';
  if (ctx.includes('MEDICUS')) return 'MEDICUS';
  if (ctx.includes('SWISS MEDICAL')) return 'SWISS MEDICAL';
  if (ctx.includes('GALENO')) return 'GALENO';
  const match = contextoBase.match(/obra social[:\s]+([A-Z][A-Za-z\s]+?)[\n\.,]/i);
  if (match) return match[1].trim().toUpperCase();
  return null;
}

async function consultarObraSocial(obraSocial) {
  if (!obraSocial) return null;

  const [{ data: prestadores }, { data: cobertura }] = await Promise.all([
    supabase
      .from('prestadores_obra_social')
      .select('tipo, especialidad, nombre, direccion, localidad, telefono, prioridad')
      .eq('obra_social', obraSocial)
      .eq('activo', true)
      .order('prioridad', { ascending: true })
      .order('localidad', { ascending: true }),
    supabase
      .from('cobertura_obra_social')
      .select('categoria, descripcion, porcentaje, condiciones')
      .eq('obra_social', obraSocial)
      .eq('activo', true)
      .order('categoria', { ascending: true })
  ]);

  if ((!prestadores || prestadores.length === 0) && (!cobertura || cobertura.length === 0)) {
    return null;
  }

  let texto = `INFORMACIÓN DE OBRA SOCIAL (${obraSocial}):\n`;

  if (cobertura && cobertura.length > 0) {
    texto += '\nCOBERTURAS:\n';
    cobertura.forEach(c => {
      texto += `- ${c.descripcion}`;
      if (c.porcentaje) texto += ` → ${c.porcentaje}`;
      if (c.condiciones) texto += `. ${c.condiciones}`;
      texto += '\n';
    });
  }

  if (prestadores && prestadores.length > 0) {
    const porTipo = {};
    prestadores.forEach(p => {
      if (!porTipo[p.tipo]) porTipo[p.tipo] = [];
      porTipo[p.tipo].push(p);
    });

    const tiposOrden = ['medico_cabecera', 'clinica', 'laboratorio', 'imagen', 'especialista', 'farmacia', 'optica'];
    const tiposLabels = {
      medico_cabecera: 'MÉDICA/O DE CABECERA',
      clinica: 'CLÍNICAS Y SANATORIOS',
      laboratorio: 'LABORATORIO',
      imagen: 'IMÁGENES Y DIAGNÓSTICO',
      especialista: 'ESPECIALISTAS',
      farmacia: 'FARMACIAS ADHERIDAS',
      optica: 'ÓPTICA'
    };

    texto += '\nPRESTADORES:\n';
    tiposOrden.forEach(tipo => {
      if (!porTipo[tipo]) return;
      texto += `\n${tiposLabels[tipo] || tipo.toUpperCase()}:\n`;
      porTipo[tipo].forEach(p => {
        texto += `- ${p.nombre}`;
        if (p.localidad) texto += ` (${p.localidad})`;
        if (p.direccion) texto += ` — ${p.direccion}`;
        if (p.telefono) texto += ` — Tel: ${p.telefono}`;
        if (p.especialidad && p.tipo !== 'farmacia') texto += ` [${p.especialidad}]`;
        texto += '\n';
      });
    });
  }

  texto += '\nUsá esta información para responder preguntas de cobertura y prestadores con contexto personal. Nunca inventes datos que no estén acá. Si falta información, decilo honestamente.';
  return texto;
}

// ─── ONBOARDING AUTOMÁTICO ───────────────────────────────────────────────────
// Heurística sobre el historial — funciona con Daniel y Roberto. El cambio
// respecto a versiones previas: el nombre se busca SOLO entre los mensajes
// del usuario que vienen después de que Sabi preguntó "¿cómo te llamás?"
// o equivalente. Antes podía agarrar un "hola" como nombre.

function extraerDatosOnboarding(historial) {
  if (!historial || historial.length === 0) return {};

  const datos = {};

  // Detectar nombre: buscar el mensaje del assistant que pregunta el nombre,
  // y tomar la primera respuesta corta del usuario que viene después.
  let preguntoNombre = false;
  for (const h of historial) {
    if (h.rol === 'assistant' && /nombre|llamás|cómo te llamas|cómo te llaman/i.test(h.mensaje)) {
      preguntoNombre = true;
      continue;
    }
    if (preguntoNombre && h.rol === 'user' && !datos.nombre) {
      const limpio = h.mensaje.trim();
      const palabras = limpio.split(/\s+/);
      if (palabras.length >= 1 && palabras.length <= 4 &&
          !limpio.includes('?') && !limpio.includes(',') &&
          /^[a-záéíóúüñA-ZÁÉÍÓÚÜÑ\s]+$/.test(limpio)) {
        datos.nombre = limpio.split(' ').map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
        break;
      }
    }
  }

  // Edad: número entre 10 y 110 en mensajes del usuario
  const mensajesUsuario = historial.filter(h => h.rol === 'user').map(h => h.mensaje);
  for (const msg of mensajesUsuario) {
    const match = msg.match(/\b(\d{2,3})\b/);
    if (match) {
      const num = parseInt(match[1]);
      if (num >= 10 && num <= 110 && !datos.edad) {
        datos.edad = num;
      }
    }
  }

  // Objetivo: último mensaje largo del usuario
  for (const msg of [...mensajesUsuario].reverse()) {
    if (msg.split(/\s+/).length > 6 && !datos.objetivo) {
      datos.objetivo = msg.trim();
      break;
    }
  }

  return datos;
}

async function procesarOnboarding(userId, estado, historial) {
  try {
    const stage = estado.onboarding_stage;
    if (stage === 'completo') return;

    const datos = extraerDatosOnboarding(historial);
    let nuevoStage = stage;
    const updates = {};

    if (stage === 'nuevo' && datos.nombre) {
      nuevoStage = 'pidio_nombre';
      updates.nombre = datos.nombre;
    }

    if ((stage === 'nuevo' || stage === 'pidio_nombre') && datos.nombre && datos.edad) {
      nuevoStage = 'pidio_edad';
      updates.nombre = datos.nombre;
    }

    if (datos.nombre && datos.edad && datos.objetivo) {
      const modoUsuario = datos.edad >= 65 ? 'adulto_mayor' : 'adulto_activo';
      const contextoBase = `Nombre: ${datos.nombre}
Edad: ${datos.edad} años
Objetivo principal: ${datos.objetivo}
Onboarding: completado automáticamente`;

      await supabase
        .from('usuarios')
        .update({ nombre: datos.nombre, contexto_base: contextoBase })
        .eq('id', userId);

      await supabase
        .from('estado_usuario')
        .update({ onboarding_stage: 'completo', modo_usuario: modoUsuario })
        .eq('usuario_id', userId);

      console.log(`Onboarding completo: ${datos.nombre}, ${datos.edad} años, modo: ${modoUsuario}`);
      return;
    }

    if (nuevoStage !== stage) {
      await supabase
        .from('estado_usuario')
        .update({ onboarding_stage: nuevoStage })
        .eq('usuario_id', userId);

      if (updates.nombre) {
        await supabase
          .from('usuarios')
          .update({ nombre: updates.nombre })
          .eq('id', userId);
      }
    }
  } catch (error) {
    console.error('Error procesando onboarding:', error.message);
  }
}

// ─── GENERAR RESPUESTA — separado del transporte HTTP ────────────────────────
// Esta función contiene TODA la lógica conversacional. Recibe usuario+mensaje,
// devuelve { respuesta, ...metadata }. No toca req/res. Eso permite que el
// mismo motor sirva tanto al endpoint web (/chat) como al webhook de WhatsApp
// cuando se conecte — sin duplicar lógica.

async function generarRespuesta(usuario, mensaje, imagenes) {
  // 1. Resolver/crear usuario y estado
  let { data: user } = await supabase
    .from('usuarios')
    .select('*')
    .eq('telefono', usuario)
    .single();

  if (!user) {
    const { data: newUser } = await supabase
      .from('usuarios')
      .insert([{ telefono: usuario, nombre: usuario }])
      .select()
      .single();
    user = newUser;
  }

  let { data: estado } = await supabase
    .from('estado_usuario')
    .select('*')
    .eq('usuario_id', user.id)
    .single();

  if (!estado) {
    const { data: nuevoEstado } = await supabase
      .from('estado_usuario')
      .insert([{ usuario_id: user.id, onboarding_stage: 'nuevo', modo_usuario: 'general', madurez_sabi: 'escucha' }])
      .select()
      .single();
    estado = nuevoEstado;
  }

  const enOnboarding = estado.onboarding_stage !== 'completo';
  const esAperturaDia = mensaje && mensaje.startsWith('APERTURA_DIA:');
  const esReapertura = mensaje === 'reapertura_del_dia';
  const esMensajeSistema = esAperturaDia || esReapertura;
  const tieneImagenes = imagenes && imagenes.length > 0;

  const imagenesValidas = tieneImagenes
    ? imagenes.filter(img => MEDIA_TYPES_VALIDOS.includes(img.tipo)).slice(0, 5)
    : null;

  // 2. Idempotencia — solo para mensajes reales del usuario (no sistema, no onboarding)
  let yaProcesado = null;
  let hashMensaje = null;
  if (!enOnboarding && !esMensajeSistema && mensaje && mensaje.length > 0) {
    hashMensaje = calcularHashMensaje(user.id, mensaje);
    yaProcesado = await mensajeYaProcesado(user.id, hashMensaje, 10);
    if (yaProcesado) {
      console.log(`Mensaje duplicado detectado (hash ${hashMensaje.slice(0, 8)}) — devolviendo respuesta vacía`);
      // Devolver una respuesta neutra que no genere otra inserción en conversaciones.
      // El cliente recibirá esto y no debería volver a mostrar nada al usuario.
      return {
        respuesta: '',
        usuario: user.nombre,
        onboarding: false,
        modo: estado.modo_usuario,
        madurez: estado.madurez_sabi,
        registros_guardados: 0,
        duplicado: true
      };
    }
  }

  // 3. Extracción de registros (solo si no estamos en onboarding ni es sistema)
  let registrosExtraidos = [];
  let cantidadGuardada = 0;
  let resultado = null;

  if (!enOnboarding && !esMensajeSistema) {
    // Estado operativo mínimo para el extractor — ayuda a evitar duplicados
    let estadoOperativo = '';
    try {
      const { data: regHoy } = await supabase
        .from('registros')
        .select('tipo_registro, comida_momento')
        .eq('usuario_id', user.id)
        .gte('fecha_evento', inicioHoyArgentina().toISOString())
        .lt('fecha_evento', inicioMananaArgentina().toISOString());
      const rh = regHoy || [];
      const flags = {
        sueno: rh.some(r => r.tipo_registro === 'sueno'),
        entrenamiento: rh.some(r => r.tipo_registro === 'entrenamiento'),
        almuerzo: rh.some(r => r.tipo_registro === 'comida' && r.comida_momento === 'almuerzo'),
        merienda: rh.some(r => r.tipo_registro === 'comida' && r.comida_momento === 'merienda'),
        cena: rh.some(r => r.tipo_registro === 'comida' && r.comida_momento === 'cena')
      };
      estadoOperativo = `[Registros de hoy: sueno=${flags.sueno}, entrenamiento=${flags.entrenamiento}, almuerzo=${flags.almuerzo}, merienda=${flags.merienda}, cena=${flags.cena}. Usá esto solo para evitar duplicados. No bloquees registros legítimos.]`;
    } catch (e) {
      console.error('Error armando estado operativo:', e.message);
    }

    resultado = await extraerRegistros(mensaje, imagenesValidas, estadoOperativo);
    registrosExtraidos = resultado.registros;
    cantidadGuardada = await guardarRegistros(user.id, mensaje, registrosExtraidos);
  }

  // 4. Post-registro: actualizar señales, madurez, hábitos
  if (cantidadGuardada > 0) {
    try {
      await evaluarSenales(user.id);
      await actualizarMadurez(user.id);
      await detectarHabitos(user.id);
      await inactivarHabitosVencidos(user.id);
    } catch (error) {
      console.error('Error post-registro:', error.message);
    }
  }

  // 5. Clasificar feedback de insight en segundo plano (no await)
  if (!enOnboarding && !esMensajeSistema && mensaje && mensaje.length > 2) {
    detectarYClasificarFeedback(user.id, mensaje);
  }

  // 6. Releer estado por si cambió (madurez)
  const { data: estadoActualizado } = await supabase
    .from('estado_usuario')
    .select('*')
    .eq('usuario_id', user.id)
    .single();
  const estadoFinal = estadoActualizado || estado;

  // 7. Historial conversacional
  const limiteHistorial = esAperturaDia ? 0 : 20;
  const { data: historial } = limiteHistorial > 0 ? await supabase
    .from('conversaciones')
    .select('rol, mensaje, fecha')
    .eq('usuario_id', user.id)
    .order('fecha', { ascending: false })
    .limit(limiteHistorial) : { data: [] };

  // 8. Eventos próximos
  const hoy = new Date();
  const en365dias = new Date();
  en365dias.setDate(hoy.getDate() + 365);

  const { data: eventosProximos } = await supabase
    .from('eventos')
    .select('*')
    .eq('usuario_id', user.id)
    .eq('activo', true)
    .gte('fecha_evento', hoy.toISOString())
    .lte('fecha_evento', en365dias.toISOString());

  // 9. Insights pendientes (filtrados por exposiciones)
  const { data: insightsPendientes } = await supabase
    .from('insights')
    .select('id, tipo_insight, regla_origen, confianza, contador_exposiciones')
    .eq('usuario_id', user.id)
    .eq('estado', 'pendiente')
    .order('created_at', { ascending: false })
    .limit(10);

  const insightsFiltrados = (insightsPendientes || []).filter(i => (i.contador_exposiciones || 0) < 3);

  // 10. Bloques de contexto
  const contextoReciente = !enOnboarding ? await armarContextoReciente(user.id) : null;
  const estadoDiaResult = !enOnboarding ? await armarEstadoDia(user.id) : null;
  const estadoDia = estadoDiaResult ? estadoDiaResult.texto : null;
  const condicionCheckin = estadoDiaResult ? estadoDiaResult.condicionCheckin : false;
  const contextoHabitos = !enOnboarding ? await armarContextoHabitos(user.id) : null;

  // 11. Trigger de check-in (cena registrada + hora >= 20 + no completado/ofrecido hoy)
  let triggerCheckin = false;
  if (!enOnboarding && !esMensajeSistema && condicionCheckin) {
    const inicioHoyCheck = inicioHoyArgentina();
    const inicioMananaCheck = inicioMananaArgentina();

    const { data: checkinHoy } = await supabase
      .from('registros')
      .select('id')
      .eq('usuario_id', user.id)
      .eq('origen', 'checkin')
      .gte('fecha_evento', inicioHoyCheck.toISOString())
      .lt('fecha_evento', inicioMananaCheck.toISOString())
      .limit(1);
    const yaCompleto = checkinHoy && checkinHoy.length > 0;

    const yaOfrecido = estadoFinal.ultimo_checkin_ofrecido_at
      ? new Date(estadoFinal.ultimo_checkin_ofrecido_at) >= inicioHoyCheck
      : false;

    triggerCheckin = !yaCompleto && !yaOfrecido;
  }

  // 12. Obra social
  let contextoObraSocial = null;
  if (!enOnboarding && !esMensajeSistema && esMensajeObraSocial(mensaje)) {
    const obraSocial = extraerObraSocial(user.contexto_base);
    if (obraSocial) contextoObraSocial = await consultarObraSocial(obraSocial);
  }

  // 13. Construcción del system prompt final
  let systemFinal = enOnboarding ? SABI_ONBOARDING : SABI_SYSTEM;

  if (!enOnboarding) {
    systemFinal += `\n\nCONTEXTO TEMPORAL: Ahora son las ${fechaCompletaArgentina()} (hora Argentina). Usá esta fecha y hora para distinguir qué pasó hoy, qué pasó ayer, y qué momento del día es ahora.`;

    if (user.contexto_base) systemFinal += `\n\nPERFIL DEL USUARIO:\n${user.contexto_base}`;

    if (estadoFinal.modo_usuario) {
      systemFinal += `\n\nMODO: ${estadoFinal.modo_usuario}`;
      if (estadoFinal.modo_usuario === 'adulto_mayor') {
        systemFinal += '\nEste usuario es un adulto mayor. Tono más simple, más cálido, más pausado.';
      }
    }

    if (estadoFinal.madurez_sabi) {
      const madurezTexto = {
        'escucha': 'Estás en etapa de escucha — primeros días. Acusá recibo, respondé consultas directas, no des insights proactivos todavía.',
        'tendencia_temprana': 'Tenés una semana de datos. Podés señalar tendencias tentativas con honestidad sobre la certeza.',
        'patron_confirmado': 'Tenés patrones confirmados. Podés dar insights con confianza y hacer sugerencias concretas basadas en correlaciones reales.',
        'profundo': 'Conocés bien el ritmo de esta persona. Podés detectar desvíos del patrón habitual y hacer conexiones sutiles entre pilares.'
      };
      systemFinal += `\n\nETAPA ACTUAL: ${madurezTexto[estadoFinal.madurez_sabi]}`;
    }

    if (contextoReciente) systemFinal += `\n\n${contextoReciente}`;
    if (contextoHabitos) systemFinal += `\n\n${contextoHabitos}`;
    if (estadoDia) systemFinal += `\n\n${estadoDia}`;

    // Resumen humano de lo recién registrado — en lugar de JSON dump
    if (registrosExtraidos.length > 0) {
      const resumen = resumirRegistrosGuardados(registrosExtraidos);
      systemFinal += `\n\nREGISTRÉ EN ESTE MENSAJE: ${resumen}. Acusá recibo breve y natural — no repitas los datos uno por uno, no enumerés.`;
    }

    // Advertencias internas según resultado de extracción
    if (!esMensajeSistema && cantidadGuardada === 0 && resultado) {
      if (resultado.requiereConfirmacionFecha) {
        systemFinal += '\n\nADVERTENCIA INTERNA: El usuario intentó registrar algo de un día pasado pero la fecha es ambigua. No digas que quedó registrado. Pedile una aclaración breve: "¿Qué día fue exactamente?"';
      } else if (resultado.timeout) {
        systemFinal += '\n\nADVERTENCIA INTERNA: La extracción tardó demasiado. Decile al usuario: "Recibí tu mensaje, tardé más de lo normal en procesarlo. Si no aparece registrado, lo revisamos." Sin decir "anotado" ni "registrado".';
      } else if (resultado.error || (mensaje && mensaje.length > 20)) {
        systemFinal += '\n\nADVERTENCIA INTERNA: No se pudo guardar ningún registro estructurado. Si el usuario intentó registrar algo, no digas "anotado", "registrado" ni "lo sumo". Respondé naturalmente sin afirmar que quedó guardado.';
      }
    }

    if (insightsFiltrados.length > 0) {
      systemFinal += '\n\nSEÑALES DETECTADAS (mencioná solo si es relevante y natural, máximo una por respuesta):\n';
      insightsFiltrados.slice(0, 3).forEach(i => {
        systemFinal += `- [id:${i.id}] ${i.tipo_insight}: ${i.regla_origen} (confianza: ${i.confianza})\n`;
      });
    }

    if (contextoObraSocial) systemFinal += `\n\n${contextoObraSocial}`;

    if (eventosProximos && eventosProximos.length > 0) {
      systemFinal += '\n\nEVENTOS PRÓXIMOS:\n';
      eventosProximos.forEach(e => {
        const fecha = new Date(e.fecha_evento).toLocaleDateString('es-AR');
        const diasRestantes = Math.ceil((new Date(e.fecha_evento) - hoy) / (1000 * 60 * 60 * 24));
        systemFinal += `- ${e.titulo}: ${fecha} (en ${diasRestantes} días) — ${e.descripcion}\n`;
      });
    }
  }

  // 14. Armar historial para el modelo
  const mensajesPrevios = (historial || [])
    .reverse()
    .filter(h => ['user', 'assistant'].includes(h.rol))
    .map(h => ({ role: h.rol, content: h.mensaje }));

  mensajesPrevios.push({ role: 'user', content: mensaje || '[imágenes]' });

  // 15. Guardar mensaje del usuario en conversaciones
  if (!esMensajeSistema) {
    await supabase.from('conversaciones').insert([{
      usuario_id: user.id,
      rol: 'user',
      mensaje: tieneImagenes ? '[imagen' + (imagenes.length > 1 ? 'es' : '') + ']' + (mensaje ? ': ' + mensaje : '') : mensaje
    }]);
  }

  // 16. Llamada al modelo
  let response;
  if (imagenesValidas && imagenesValidas.length > 0) {
    response = await generarRespuestaConImagenes(systemFinal, mensajesPrevios, mensaje, imagenesValidas);
  } else {
    response = await anthropic.messages.create({
      model: MODELO,
      max_tokens: 500,
      system: systemFinal,
      messages: mensajesPrevios,
    });
  }

  let respuestaRaw = response.content[0].text;

  // 17. Parsear tag de insight usado
  const insightTagMatch = respuestaRaw.match(/\[INSIGHT_ID:\s*([a-zA-Z0-9-]+)\]/i);
  let respuesta = respuestaRaw.replace(/\[INSIGHT_ID:\s*[a-zA-Z0-9-]+\]\s*/gi, '').trimEnd();
  const insightUsadoId = insightTagMatch ? insightTagMatch[1] : null;

  // 18. Guardar respuesta
  await supabase.from('conversaciones').insert([{ usuario_id: user.id, rol: 'assistant', mensaje: respuesta }]);

  // 19. Actualizar estado_usuario
  const updateEstadoPayload = { ultimo_mensaje_at: new Date().toISOString() };
  if (insightUsadoId) {
    updateEstadoPayload.ultimo_insight_mostrado_id = insightUsadoId;
    updateEstadoPayload.ultimo_insight_mostrado_at = new Date().toISOString();
    console.log(`Insight ${insightUsadoId} marcado como mostrado`);

    try {
      const { data: insightActual } = await supabase
        .from('insights')
        .select('contador_exposiciones')
        .eq('id', insightUsadoId)
        .single();
      await supabase
        .from('insights')
        .update({
          estado: 'comunicado',
          comunicado_al_usuario: true,
          fecha_comunicacion: new Date().toISOString(),
          contador_exposiciones: ((insightActual?.contador_exposiciones || 0) + 1)
        })
        .eq('id', insightUsadoId);
    } catch (e) {
      console.error('Error actualizando insight comunicado:', e.message);
    }
  }
  if (triggerCheckin) updateEstadoPayload.ultimo_checkin_ofrecido_at = new Date().toISOString();
  await supabase.from('estado_usuario').update(updateEstadoPayload).eq('usuario_id', user.id);

  // 20. Onboarding automático
  if (enOnboarding) {
    const historialCompleto = await supabase
      .from('conversaciones')
      .select('rol, mensaje')
      .eq('usuario_id', user.id)
      .order('fecha', { ascending: true })
      .limit(30);
    await procesarOnboarding(user.id, estadoFinal, historialCompleto.data || []);
  }

  // 21. Marcar mensaje como procesado (idempotencia)
  if (hashMensaje) {
    await registrarMensajeProcesado(user.id, hashMensaje, mensaje, cantidadGuardada, 'procesado');
  }

  // 22. Devolver payload
  const payload = {
    respuesta,
    usuario: user.nombre,
    onboarding: enOnboarding,
    modo: estadoFinal.modo_usuario,
    madurez: estadoFinal.madurez_sabi,
    registros_guardados: cantidadGuardada,
    insights_pendientes: insightsFiltrados.length,
    trigger_checkin: triggerCheckin || false
  };

  if (triggerCheckin) {
    payload.checkin = { preguntas: PREGUNTAS_CHECKIN };
  }

  return payload;
}

// ─── PREGUNTAS DE CHECK-IN (compartidas entre /chat y /checkin) ──────────────

const PREGUNTAS_CHECKIN = [
  { id: 1, pregunta: '¿Cómo estuvo tu energía hoy?', opciones: ['Alta', 'Normal', 'Baja', 'Muy baja'] },
  { id: 2, pregunta: '¿Cómo te sentiste por dentro?', opciones: ['Bien', 'Regular', 'Pesado', 'Ansioso'] },
  { id: 3, pregunta: '¿Estuviste con gente que te hace bien?', opciones: ['Sí, estuvo bueno', 'Algo, poco', 'Solo todo el día'] },
  { id: 4, pregunta: '¿Ya estás soltando el día?', opciones: ['Sí, desconectando', 'Más o menos', 'No, sigo en modo trabajo'] },
  { id: 5, pregunta: '¿Cómo estuvo el cuerpo?', opciones: ['Liviano', 'Normal', 'Pesado o cansado', 'Algo molesto'] },
  { id: 6, pregunta: '¿Algo del día que quieras dejar anotado?', opciones: ['Sí, te cuento', 'No, ya está'], opcional: true }
];

const MAPA_ENERGIA_CHECKIN = { 'Alta': 5, 'Normal': 3, 'Baja': 2, 'Muy baja': 1 };

// ─── ENDPOINTS HTTP ──────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'Sabi está vivo', version: '3.6.0' });
});

app.post('/chat', async (req, res) => {
  const { usuario, mensaje, imagenes } = req.body;
  if (!usuario || (!mensaje && (!imagenes || imagenes.length === 0))) {
    return res.status(400).json({ error: 'Faltan usuario y mensaje o imágenes' });
  }
  try {
    const resultado = await generarRespuesta(
      usuario,
      mensaje || '',
      imagenes ? imagenes.slice(0, 5) : null
    );
    res.json(resultado);
  } catch (error) {
    console.error('Error en /chat:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET legacy — solo en dev. En producción no se monta el endpoint.
if (IS_DEV) {
  app.get('/chat/:usuario/:mensaje', async (req, res) => {
    try {
      const resultado = await generarRespuesta(req.params.usuario, req.params.mensaje, null);
      res.json(resultado);
    } catch (error) {
      console.error('Error en GET /chat legacy:', error);
      res.status(500).json({ error: error.message });
    }
  });
  console.log('GET /chat/:usuario/:mensaje habilitado (NODE_ENV != production)');
}

app.post('/resumen', async (req, res) => {
  const { usuario } = req.body;
  if (!usuario) return res.status(400).json({ error: 'Falta usuario' });
  try {
    const { data: user } = await supabase.from('usuarios').select('*').eq('telefono', usuario).single();
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const resumen = await generarResumenSemanal(user.id);

    await supabase.from('conversaciones').insert([{ usuario_id: user.id, rol: 'assistant', mensaje: resumen }]);
    await supabase.from('estado_usuario').update({ ultimo_resumen_semanal_at: new Date().toISOString() }).eq('usuario_id', user.id);

    res.json({ resumen, usuario: user.nombre });
  } catch (error) {
    console.error('Error en /resumen:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/checkin/:usuario', async (req, res) => {
  try {
    const { data: user } = await supabase.from('usuarios').select('*').eq('telefono', req.params.usuario).single();
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({
      mensaje: `¿Cómo terminó el día, ${user.nombre}?`,
      preguntas: PREGUNTAS_CHECKIN
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/checkin', async (req, res) => {
  const { usuario, respuestas } = req.body;
  if (!usuario || !respuestas || !Array.isArray(respuestas)) {
    return res.status(400).json({ error: 'Falta usuario o respuestas' });
  }
  try {
    const { data: user } = await supabase.from('usuarios').select('*').eq('telefono', usuario).single();
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const ahora = new Date().toISOString();
    const registrosCheckin = [];

    for (const r of respuestas) {
      if (r.id === 1) {
        const valorEnergia = MAPA_ENERGIA_CHECKIN[r.valor] || null;
        if (valorEnergia) {
          registrosCheckin.push({
            usuario_id: user.id, tipo_registro: 'estado', fecha_evento: ahora,
            mensaje_original: `[checkin] energía: ${r.valor}`, origen: 'checkin',
            energia: valorEnergia, nota_libre: `Energía del día: ${r.valor}`
          });
        }
      } else if (r.id === 2) {
        registrosCheckin.push({
          usuario_id: user.id, tipo_registro: 'estado', fecha_evento: ahora,
          mensaje_original: `[checkin] estado emocional: ${r.valor}`, origen: 'checkin',
          nota_libre: `Estado emocional: ${r.valor}`
        });
      } else if (r.id === 3 || r.id === 4) {
        registrosCheckin.push({
          usuario_id: user.id, tipo_registro: 'estado', fecha_evento: ahora,
          mensaje_original: `[checkin] p${r.id}: ${r.valor}`, origen: 'checkin',
          nota_libre: r.id === 3 ? `Contacto social: ${r.valor}` : `Desconexión del día: ${r.valor}`
        });
      } else if (r.id === 5) {
        registrosCheckin.push({
          usuario_id: user.id, tipo_registro: 'estado', fecha_evento: ahora,
          mensaje_original: `[checkin] cuerpo: ${r.valor}`, origen: 'checkin',
          nota_libre: `Cuerpo: ${r.valor}`
        });
      } else if (r.id === 6 && r.valor && r.valor !== 'No, ya está') {
        registrosCheckin.push({
          usuario_id: user.id, tipo_registro: 'evento', fecha_evento: ahora,
          mensaje_original: `[checkin] nota: ${r.valor}`, origen: 'checkin',
          nota_libre: r.valor
        });
      }
    }

    let guardados = 0;
    if (registrosCheckin.length > 0) {
      const { data, error } = await supabase.from('registros').insert(registrosCheckin).select('id');
      if (!error && data) guardados = data.length;
      else if (error) console.error('Error guardando checkin:', error.message);
    }

    const resumenTexto = respuestas
      .filter(r => r.valor)
      .map(r => `p${r.id}: ${r.valor}`)
      .join(' | ');
    await supabase.from('conversaciones').insert([{
      usuario_id: user.id, rol: 'user',
      mensaje: `[check-in cierre] ${resumenTexto}`
    }]);

    await supabase
      .from('estado_usuario')
      .update({ ultimo_checkin_at: new Date().toISOString() })
      .eq('usuario_id', user.id);

    res.json({ ok: true, registros_guardados: guardados });
  } catch (error) {
    console.error('Error guardando check-in:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── ARRANQUE ────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sabi v3.6.0 escuchando en puerto ${PORT}`);
  console.log(`NODE_ENV: ${process.env.NODE_ENV || 'no-set (dev mode)'}`);
  console.log(`CORS allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
});
