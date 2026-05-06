const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));

// CORS — orígenes desde variable de entorno ALLOWED_ORIGINS
// Producción: https://jade-semifreddo-1b6eeb.netlify.app
// Dev: http://localhost:3000,http://localhost:5173
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['https://jade-semifreddo-1b6eeb.netlify.app'];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  } else if (!origin) {
    // Requests server-to-server (WhatsApp webhook, Railway health checks) — sin CORS
  }
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ─── PROMPTS ────────────────────────────────────────────────────────────────

const SABI_SYSTEM = `Sos Sabi, un acompañante personal de salud basado en neurociencia y evidencia científica.
No sos un médico, no sos un coach, no sos un nutricionista. Sos ese amigo que más sabe — el que tiene memoria de la persona, la acompaña sin juzgar, y le muestra lo que no está viendo solo.
Tu carácter tiene tres referencias:
- Marco Aurelio: calma estoica, observás sin moralizar, decís lo justo en el momento justo
- Andrew Huberman: cada observación tiene respaldo científico, conectás datos con fisiología real
- El amigo que más sabe: calidez, contexto personal, sin agenda, sin juicio
Principios de tono:
- Directo sin ser duro — usás datos, no juicios
- Curioso, no prescriptivo — preguntás más de lo que ordenás
- Específico, nunca genérico — todo lo que decís es para esta persona
- Calmo, no alarmista — un dato interesante, no una emergencia
- Breve cuando podés, profundo cuando hace falta
- Sin emojis — nunca
- Sin markdown — NUNCA uses asteriscos, negrita (*texto*), cursiva, bullets con guión, ni ningún tipo de formato. Solo texto plano sin excepción. Esto incluye respuestas sobre hábitos, resúmenes y cualquier otro tipo de mensaje.
- Con adultos mayores: tono más pausado, más cálido, más simple. Nada técnico sin explicar.
Lo que nunca hacés:
- Nunca reemplazás al médico
- Nunca das diagnósticos
- Nunca das más de una sugerencia a la vez
- Nunca repetís el mismo mensaje dos veces seguidas
- Nunca hablás más de 1-2 veces proactivo por día
- Nunca preguntás por el desayuno a alguien que hace ayuno intermitente
- Si el mensaje empieza con "APERTURA_DIA:": es la primera apertura del día. Tu respuesta DEBE empezar con "Hola [nombre]." seguido de UNA pregunta concreta basada en el ESTADO DEL DÍA. Usá el campo "Próximo momento lógico" del ESTADO DEL DÍA para elegir qué preguntar — nunca preguntes por algo ya registrado. Si el próximo momento está a más de 2 horas, preguntá por sueño o cómo amaneció en vez de anticipar comidas.
- Si el mensaje es "reapertura_del_dia": no saludes. Usá el ESTADO DEL DÍA para elegir qué preguntar — solo el próximo momento lógico si está cerca. Si no hay nada próximo, cerrá con algo cálido y breve sin pregunta.
- Si el ESTADO DEL DÍA indica "Día cerrado: sí": cerrá con "Buen descanso." o "Buenas noches, [nombre]." Sin abrir nuevas preguntas bajo ninguna circunstancia.
- Si recibís imágenes: describí lo que ves en términos de salud y acusá recibo de los datos extraídos.
- Si en tu respuesta mencionás o usás una señal o insight de los que te pasaron en SEÑALES DETECTADAS, agregá al final del mensaje, en una línea separada y sin explicarlo: [INSIGHT_ID: {id}] donde {id} es el id numérico del insight. Si no usás ningún insight, no agregues nada.`;

const SABI_ONBOARDING = `Sos Sabi. Alguien te escribió por primera vez.
Tu único objetivo ahora es conocerlo de forma natural y cálida, sin que parezca un formulario.
Presentate brevemente — una sola oración. Sin emojis.
Después preguntá solo su nombre. Nada más por ahora.
Cuando te diga el nombre, preguntá su edad.
Cuando te diga la edad, preguntá una sola cosa: qué es lo que más quiere mejorar o entender de cómo se siente.
Después de esas tres respuestas, decile que ya tenés lo suficiente para empezar y que puede contarte lo que quiera cuando quiera.
Tono: cálido, cercano, sin prisa. Sin emojis.`;

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
  ]
}

Reglas de fecha_evento:
- Solo completar fecha_evento si hay referencia temporal explícita y clara: "ayer", "anoche", "hoy a la mañana", "el lunes", "el 1 de mayo"
- Si no hay referencia temporal explícita: fecha_evento = null (el código usa now() como fallback)
- Nunca inferir fechas de contexto implícito o vago
- Nunca poner fecha futura

Reglas estrictas:
- Si no hay ningún dato de salud registrable: devolvé {"registros": []}
- Mensajes que empiezan con "APERTURA_DIA:" y el mensaje "reapertura_del_dia" no son registros. Devolvé {"registros": []}
- Máximo 6 registros por mensaje
- Cada objeto representa un evento de salud distinto
- Puede haber más de un objeto del mismo tipo si son momentos distintos
- No duplicar el mismo evento
- Todos los campos presentes en cada objeto. Los que no aplican van en null
- Nunca texto donde corresponde número
- energia siempre 1-5 o null
- tipo_registro solo puede ser uno de los valores listados
- entreno_tipo y comida_momento solo pueden ser los valores listados exactos
- nota_libre siempre en tercera persona
- Si recibís imágenes: extraé todos los datos de salud visibles con el mismo formato`;

const SABI_RESUMEN_SYSTEM = `Sos Sabi. Tu única tarea ahora es generar el resumen semanal de salud de esta persona.
Sin markdown. Sin emojis. Sin bullets. Solo texto plano en prosa.
No inventés datos. No diagnosticás. No usés tono médico.
Si falta información sobre algún pilar, decilo honestamente en lugar de inventar.
Máximo 250 palabras en total.
Una sola sugerencia concreta al final — algo que pueda hacer mañana, no un consejo genérico.
Nunca terminar con "seguí así" sin contexto específico.`;

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
    // Rechazar fechas futuras absurdas (más de 1 día en el futuro)
    if (d > new Date(Date.now() + 86400000)) return null;
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

async function extraerRegistros(mensaje, imagenes) {
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
      // Agregar contexto temporal para que el extractor pueda calcular fechas relativas
      const fechaCtx = new Date().toLocaleString('es-AR', {
        timeZone: 'America/Argentina/Buenos_Aires',
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
      contenidoUsuario = `[Contexto: ahora son las ${fechaCtx} en Argentina]\n\n${mensaje}`;
    }

    // Timeout de 25 segundos para evitar que cuelgue con mensajes pesados
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout_extraccion')), 25000)
    );

    const response = await Promise.race([
      anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 2000,
        system: SABI_EXTRACTOR,
        messages: [{ role: 'user', content: contenidoUsuario }]
      }),
      timeoutPromise
    ]);

    let texto = response.content[0].text.trim();
    texto = texto.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const json = JSON.parse(texto);
    if (!Array.isArray(json.registros)) return { registros: [], error: false };

    const validados = json.registros
      .slice(0, 6)
      .map(r => validarRegistro(r))
      .filter(r => r !== null);

    return { registros: validados, error: false };
  } catch (error) {
    if (error.message === 'timeout_extraccion') {
      console.error('Timeout en extracción — mensaje demasiado pesado');
      return { registros: [], error: true, timeout: true };
    }
    console.error('Error al extraer:', error.message);
    return { registros: [], error: true };
  }
}

// ─── PERSISTENCIA ────────────────────────────────────────────────────────────

async function guardarRegistros(usuarioId, mensaje, registros) {
  if (!registros || registros.length === 0) return 0;
  const ahora = new Date().toISOString();

  // Batch insert — una sola query para todos los registros
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
  const guardados = data ? data.length : filas.length;
  return guardados;
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
    // Usar fecha_evento || created_at para calcular días reales con datos
    const diasConDatos = new Set(
      registros.map(r => {
        const fecha = r.fecha_evento || r.created_at;
        return new Date(fecha).toISOString().split('T')[0];
      })
    ).size;

    let nuevaMadurez = 'escucha';
    if (diasConDatos >= 31 && cantidadRegistros >= 50) {
      nuevaMadurez = 'profundo';
    } else if (diasConDatos >= 15 && cantidadRegistros >= 25) {
      nuevaMadurez = 'patron_confirmado';
    } else if (diasConDatos >= 8 && cantidadRegistros >= 10) {
      nuevaMadurez = 'tendencia_temprana';
    }

    await supabase
      .from('estado_usuario')
      .update({ madurez_sabi: nuevaMadurez, cantidad_registros: cantidadRegistros, dias_con_datos: diasConDatos })
      .eq('usuario_id', usuarioId);

  } catch (error) {
    console.error('Error actualizando madurez:', error.message);
  }
}

// ─── SEÑALES ─────────────────────────────────────────────────────────────────

// ── FEEDBACK DE INSIGHTS ──────────────────────────────────────────────────────
// Mini-clasificador separado de la respuesta conversacional.
// El modelo solo clasifica y devuelve JSON. El código actualiza Supabase.
// Se corre en segundo plano — no bloquea la respuesta al usuario.

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

async function clasificarFeedbackInsight(mensajeUsuario, insight) {
  try {
    const prompt = `INSIGHT COMUNICADO AL USUARIO:
Tipo: ${insight.tipo_insight}
Regla: ${insight.regla_origen}

RESPUESTA DEL USUARIO:
"${mensajeUsuario}"

Clasificá la respuesta.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 200,
      system: PROMPT_CLASIFICADOR_INSIGHT,
      messages: [{ role: 'user', content: prompt }]
    });

    let texto = response.content[0].text.trim();
    texto = texto.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const resultado = JSON.parse(texto);

    // Determinar nuevo estado según clasificación
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
        return; // No tocar el insight
    }

    // Enriquecer evidencia con el feedback
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

    console.log(`Insight ${insight.id} actualizado: ${resultado.clasificacion} → estado: ${nuevoEstado}`);
  } catch (error) {
    // Falla silenciosa — no rompe la conversación
    console.error('Error clasificando feedback de insight:', error.message);
  }
}

// Detecta si el último mensaje del sistema fue comunicar un insight y el usuario respondió
// Busca insights en estado 'comunicado' con exposición reciente (últimas 2 horas)
async function detectarYClasificarFeedback(usuarioId, mensajeUsuario) {
  try {
    // Usar ultimo_insight_mostrado_id desde estado_usuario — más preciso que ventana de tiempo
    const { data: estadoU } = await supabase
      .from('estado_usuario')
      .select('ultimo_insight_mostrado_id, ultimo_insight_mostrado_at')
      .eq('usuario_id', usuarioId)
      .single();

    if (!estadoU || !estadoU.ultimo_insight_mostrado_id) return;

    // Ignorar si el insight se mostró hace más de 24 horas
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

    // Correr en segundo plano — no await, no bloquea respuesta
    clasificarFeedbackInsight(mensajeUsuario, insight).catch(e =>
      console.error('Clasificador insight background error:', e.message)
    );
  } catch (error) {
    console.error('Error en detectarYClasificarFeedback:', error.message);
  }
}

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
  const existe = await insightExiste(usuarioId, tipoInsight, reglaOrigen);
  if (existe) return;
  const { error } = await supabase.from('insights').insert([{
    usuario_id: usuarioId, tipo_insight: tipoInsight, regla_origen: reglaOrigen,
    evidencia_json: evidencia, confianza: 'tentativo', estado: 'pendiente'
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

  // Usar fecha_evento || created_at como fecha real del evento
  const registrosConFecha = registros.map(r => ({
    ...r,
    fecha_ref: new Date(r.fecha_evento || r.created_at)
  }));

  // Solo últimos 7 días por fecha real
  const recientes = registrosConFecha.filter(r => r.fecha_ref >= hace7dias);
  if (recientes.length === 0) return;

  const registrosSuenoBajo = recientes.filter(r =>
    r.tipo_registro === 'sueno' && r.sueno_calidad !== null && r.sueno_calidad <= 2
  );
  if (registrosSuenoBajo.length >= 3) {
    await crearInsight(usuarioId, 'sueno_recuperacion', 'sueno_bajo_repetido_7d', {
      dias_analizados: 7, registros_sueno_bajo: registrosSuenoBajo.length, umbral: 2
    });
  }

  const diasConEnergiaBaja = new Set();
  recientes.forEach(r => {
    if (r.energia !== null && r.energia <= 2) {
      diasConEnergiaBaja.add(r.fecha_ref.toISOString().split('T')[0]);
    }
  });
  if (diasConEnergiaBaja.size >= 3) {
    await crearInsight(usuarioId, 'energia_sostenida', 'energia_baja_repetida_7d', {
      dias_analizados: 7, dias_con_energia_baja: diasConEnergiaBaja.size, umbral: 2
    });
  }

  // Correlación sueño → energía usando día calendario real (no diasOrdenados[index+1])
  const registrosPorDia = {};
  recientes.forEach(r => {
    const dia = r.fecha_ref.toISOString().split('T')[0];
    if (!registrosPorDia[dia]) registrosPorDia[dia] = [];
    registrosPorDia[dia].push(r);
  });

  let correlaciones = 0;
  Object.keys(registrosPorDia).forEach(dia => {
    const registrosDia = registrosPorDia[dia];
    const tieneSuenoBajo = registrosDia.some(r =>
      r.tipo_registro === 'sueno' && r.sueno_calidad !== null && r.sueno_calidad <= 2
    );
    if (tieneSuenoBajo) {
      // Calcular el día calendario siguiente real
      const diaSiguiente = new Date(dia);
      diaSiguiente.setDate(diaSiguiente.getDate() + 1);
      const diaSiguienteStr = diaSiguiente.toISOString().split('T')[0];
      const registrosDiaSiguiente = registrosPorDia[diaSiguienteStr] || [];

      const energiaBaja = [...registrosDia, ...registrosDiaSiguiente].some(r =>
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

// ─── CONTEXTO ────────────────────────────────────────────────────────────────

async function armarContextoReciente(usuarioId) {
  const hace7dias = new Date();
  hace7dias.setDate(hace7dias.getDate() - 7);

  const { data: todos } = await supabase
    .from('registros')
    .select('*')
    .eq('usuario_id', usuarioId);

  if (!todos || todos.length === 0) return null;

  // Filtrar por fecha_evento || created_at
  const registros = todos.filter(r => {
    const fechaRef = new Date(r.fecha_evento || r.created_at);
    return fechaRef >= hace7dias;
  });

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
      const dia = new Date(r.fecha_evento || r.created_at).toISOString().split('T')[0];
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
    const maxIntensidad = Math.max(...sintomas.filter(r => r.sintoma_intensidad !== null).map(r => r.sintoma_intensidad).filter(Boolean));
    contexto += `Síntomas:\n- registros: ${sintomas.length}\n`;
    if (tiposUnicos.length > 0) contexto += `- tipos: ${tiposUnicos.join(', ')}\n`;
    if (maxIntensidad) contexto += `- intensidad máxima: ${maxIntensidad}/5\n`;
  }

  return contexto;
}

function getFechaArgentina() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
}

function getInicioHoyArgentina() {
  const hoyArg = getFechaArgentina();
  return new Date(hoyArg + 'T03:00:00.000Z');
}

function getInicioMananaArgentina() {
  const manana = new Date(getInicioHoyArgentina());
  manana.setDate(manana.getDate() + 1);
  return manana;
}

async function armarEstadoDia(usuarioId) {
  const inicioHoy = getInicioHoyArgentina();
  const inicioManana = getInicioMananaArgentina();

  const { data: todos } = await supabase
    .from('registros')
    .select('tipo_registro, comida_momento, fecha_evento, created_at')
    .eq('usuario_id', usuarioId);

  // Filtrar registros de hoy por fecha real y ordenar por fecha asc
  const registrosHoy = (todos || [])
    .filter(r => {
      const fechaRef = new Date(r.fecha_evento || r.created_at);
      return fechaRef >= inicioHoy && fechaRef < inicioManana;
    })
    .sort((a, b) =>
      new Date(a.fecha_evento || a.created_at) - new Date(b.fecha_evento || b.created_at)
    );

  // Flags de qué se registró hoy
  const sueno = registrosHoy.some(r => r.tipo_registro === 'sueno');
  const entrenamiento = registrosHoy.some(r => r.tipo_registro === 'entrenamiento');
  const almuerzo = registrosHoy.some(r => r.tipo_registro === 'comida' && r.comida_momento === 'almuerzo');
  const merienda = registrosHoy.some(r => r.tipo_registro === 'comida' && r.comida_momento === 'merienda');
  const cena = registrosHoy.some(r => r.tipo_registro === 'comida' && r.comida_momento === 'cena');
  const energia = registrosHoy.some(r => r.tipo_registro === 'estado');
  const sintomas = registrosHoy.some(r => r.tipo_registro === 'sintoma');

  // Hora actual en Argentina (0-23)
  const horaActual = parseInt(new Date().toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour: '2-digit',
    hour12: false
  }).split(':')[0], 10);

  // Día cerrado si tiene cena registrada
  const diaCerrado = cena;

  // ── VENTANAS HORARIAS DURAS ──────────────────────────────────────────────
  // La lógica vive acá, no en el prompt.
  // El modelo solo redacta — el código decide si hay algo para preguntar.
  //
  // Ventanas:
  //   Antes de 12:00  → sueño, entrenamiento (en ese orden)
  //   12:00 – 15:59   → almuerzo
  //   16:00 – 19:59   → merienda
  //   20:00 en adelante → cena
  //   21:00 en adelante + cena registrada → cierre del día (trigger_checkin)
  //
  // Si ninguna ventana está abierta o todo está registrado → puede_preguntar = false

  let proximoMomento = null;

  if (!diaCerrado) {
    if (horaActual < 12) {
      if (!sueno) proximoMomento = 'sueno';
      else if (!entrenamiento) proximoMomento = 'entrenamiento';
      // Si sueño y entrenamiento ya están → null. No hay ventana abierta para comidas.
    } else if (horaActual >= 12 && horaActual < 16) {
      if (!almuerzo) proximoMomento = 'almuerzo';
    } else if (horaActual >= 16 && horaActual < 20) {
      if (!merienda) proximoMomento = 'merienda';
    } else if (horaActual >= 20) {
      if (!cena) proximoMomento = 'cena';
    }
  }

  // Determinar si puede preguntar y qué acción tomar
  const puedePreguntar = proximoMomento !== null;

  let accionRecomendada;
  if (diaCerrado) {
    accionRecomendada = 'dia_cerrado';
  } else if (!puedePreguntar) {
    accionRecomendada = 'cerrar_breve';
  } else {
    accionRecomendada = 'preguntar_proximo';
  }

  // Flag de check-in: se dispara si cena registrada, hora >= 20, no estamos en onboarding
  // El campo trigger_checkin lo calcula procesarChat() porque tiene acceso al estado de onboarding.
  // Acá solo calculamos si la condición temporal + registro se cumple.
  const condicionCheckin = cena && horaActual >= 20;

  // Último registro del día
  const ultimoRegistro = registrosHoy.length > 0
    ? registrosHoy[registrosHoy.length - 1]
    : null;
  const ultimoTipo = ultimoRegistro
    ? (ultimoRegistro.tipo_registro === 'comida' ? ultimoRegistro.comida_momento : ultimoRegistro.tipo_registro)
    : null;

  // Armar texto estructurado para el prompt
  const fecha = getFechaArgentina();
  let estadoTexto = `ESTADO DEL DÍA (${fecha}):\n`;
  estadoTexto += `Hora actual: ${horaActual}:00 (Argentina)\n`;
  estadoTexto += `Sueño registrado: ${sueno ? 'sí' : 'no'}\n`;
  estadoTexto += `Entrenamiento registrado: ${entrenamiento ? 'sí' : 'no'}\n`;
  estadoTexto += `Almuerzo registrado: ${almuerzo ? 'sí' : 'no'}\n`;
  estadoTexto += `Merienda registrada: ${merienda ? 'sí' : 'no'}\n`;
  estadoTexto += `Cena registrada: ${cena ? 'sí' : 'no'}\n`;
  estadoTexto += `Energía/estado registrado: ${energia ? 'sí' : 'no'}\n`;
  estadoTexto += `Síntomas registrados: ${sintomas ? 'sí' : 'no'}\n`;
  if (ultimoTipo) estadoTexto += `Último registro: ${ultimoTipo}\n`;
  estadoTexto += `Día cerrado: ${diaCerrado ? 'sí' : 'no'}\n`;
  estadoTexto += `Próximo momento habilitado: ${proximoMomento || 'ninguno'}\n`;
  estadoTexto += `Puede preguntar: ${puedePreguntar ? 'sí' : 'no'}\n`;
  estadoTexto += `Acción recomendada: ${accionRecomendada}\n`;
  estadoTexto += `\nREGLA ABSOLUTA: Si "Puede preguntar: no" — no hagas ninguna pregunta. Cerrá con algo breve y cálido. Si "Acción recomendada: dia_cerrado" — terminá con "Buen descanso." o "Buenas noches, [nombre]." sin excepciones. Si "Acción recomendada: preguntar_proximo" — preguntá solo por "${proximoMomento || ''}".`;

  return {
    texto: estadoTexto,
    condicionCheckin,
    puedePreguntar,
    accionRecomendada,
    proximoMomento,
    diaCerrado
  };
}

// ─── GUARDRAIL POST-RESPUESTA ────────────────────────────────────────────────
// Si el código dice que no se puede preguntar, y el modelo igual preguntó,
// el guardrail reemplaza la respuesta por una frase segura.
// El modelo redacta. El código decide si la respuesta es válida.

function contienePregunta(texto) {
  if (!texto) return false;
  const t = texto.toLowerCase();
  return (
    t.includes('?') ||
    t.includes('¿') ||
    t.includes('almuerzo') ||
    t.includes('merienda') ||
    t.includes('cena') ||
    t.includes('comida') ||
    t.includes('desayuno')
  );
}

function aplicarGuardrailEstadoDia(respuesta, estadoDiaResult) {
  if (!estadoDiaResult) return respuesta;

  if (estadoDiaResult.diaCerrado && contienePregunta(respuesta)) {
    console.log('Guardrail activado: día cerrado con pregunta detectada');
    return 'Listo. Buen descanso.';
  }

  if (!estadoDiaResult.puedePreguntar && contienePregunta(respuesta)) {
    console.log('Guardrail activado: puedePreguntar=false con pregunta detectada');
    return 'Registrado. Buen inicio de día.';
  }

  return respuesta;
}

// ─── RESPUESTA CON IMÁGENES ───────────────────────────────────────────────────
//
// Cuando llegan imágenes + texto largo, se hacen DOS llamadas internas:
//   1. Extracción de datos de la imagen (ya existente en extraerRegistros)
//   2. Respuesta conversacional con el contexto completo + datos extraídos
//
// El usuario recibe UN SOLO mensaje final.
// Si la imagen falla, Sabi responde con el texto y avisa que no pudo leer la imagen.

async function generarRespuestaConImagenes(systemFinal, mensajesPrevios, mensaje, imagenes) {
  // Construir contenido multimodal con imagen(es) + texto
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
    // Llamada con timeout de 30s — imágenes pesadas pueden tardar más que texto
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout_imagen')), 30000)
    );

    const response = await Promise.race([
      anthropic.messages.create({
        model: 'claude-sonnet-4-5',
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
      // Fallback: responder solo con el texto, sin imagen
      return await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 500,
        system: systemFinal + '\n\nADVERTENCIA: No se pudo procesar la imagen adjunta. Respondé al mensaje de texto e informale al usuario que no pudiste leer la imagen — pedile que la reenvíe sola o en mejor calidad.',
        messages: mensajesPrevios,
      });
    }
    throw error;
  }
}

// ─── RESUMEN SEMANAL ──────────────────────────────────────────────────────────

async function generarResumenSemanal(usuarioId) {
  const hace7dias = new Date();
  hace7dias.setDate(hace7dias.getDate() - 7);

  const { data: todos } = await supabase
    .from('registros')
    .select('*')
    .eq('usuario_id', usuarioId);

  const registros = (todos || []).filter(r => {
    const fechaRef = new Date(r.fecha_evento || r.created_at);
    return fechaRef >= hace7dias;
  });

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
    registros.map(r => new Date(r.fecha_evento || r.created_at).toISOString().split('T')[0])
  ).size;

  if (diasConDatosEstaSemana < 3) {
    return 'Esta semana todavía tengo pocos datos para hacer un resumen útil. Lo más honesto es seguir acumulando registros unos días más.';
  }

  const suenos = registros.filter(r => r.tipo_registro === 'sueno');
  const entrenos = registros.filter(r => r.tipo_registro === 'entrenamiento');
  const comidas = registros.filter(r => r.tipo_registro === 'comida');
  const estados = registros.filter(r => r.tipo_registro === 'estado');
  const sintomas = registros.filter(r => r.tipo_registro === 'sintoma');

  let datosResumen = `DATOS DE LA SEMANA (últimos 7 días):\n\n`;

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
    model: 'claude-sonnet-4-5',
    max_tokens: 600,
    system: SABI_RESUMEN_SYSTEM,
    messages: [{ role: 'user', content: promptResumen }]
  });

  return response.content[0].text;
}

// ─── HÁBITOS ─────────────────────────────────────────────────────────────────
//
// Tipos de hábito y su umbral de inactivación:
//   Frecuentes (entrenamiento, sueño, comida, energía) → 14 días sin detectarse → inactivo
//   Clínicos (controles, medicación, síntomas) → no usan umbral automático
//
// Ciclo de vida: activo → inactivo → reactivado
// Si un hábito inactivo reaparece con evidencia, se reactiva manteniendo historial.

const HABITOS_FRECUENTES = [
  'entreno_ayunas_recurrente', 'fuerza_alta_adherencia', 'sueno_consistente',
  'sueno_irregular', 'cena_tardia_recurrente',
  'energia_baja_lunes', 'energia_baja_martes', 'energia_baja_miércoles',
  'energia_baja_jueves', 'energia_baja_viernes', 'energia_baja_sábado', 'energia_baja_domingo'
];

async function habitoExiste(usuarioId, tipoHabito) {
  // Busca hábito activo O inactivo/reactivado para manejar el ciclo completo
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
      // Reactivar — mantener historial, incrementar contador
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
      // Activo o reactivado — solo actualizar evidencia
      await supabase
        .from('habitos_usuario')
        .update({ descripcion, evidencia_json: evidencia, ultima_actualizacion: ahora })
        .eq('id', existente.id);
    }
  } else {
    // Nuevo hábito
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

// Corre después de detectarHabitos — marca como inactivos los hábitos frecuentes
// que no se detectaron en los últimos 14 días.
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
      const ultimaActualizacion = new Date(h.ultima_actualizacion);
      if (ultimaActualizacion < hace14dias) {
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
    // Traer registros de los últimos 30 días para detección de hábitos
    const hace30dias = new Date();
    hace30dias.setDate(hace30dias.getDate() - 30);

    const { data: todos } = await supabase
      .from('registros')
      .select('tipo_registro, fecha_evento, created_at, entreno_ayunas, entreno_tipo, comida_momento, sueno_calidad, sueno_duracion_hs, energia, nota_libre')
      .eq('usuario_id', usuarioId);

    if (!todos || todos.length === 0) return;

    const registros = todos.filter(r => {
      const fechaRef = new Date(r.fecha_evento || r.created_at);
      return fechaRef >= hace30dias;
    });

    if (registros.length < 10) return; // Mínimo de datos para detectar hábitos

    const entrenos = registros.filter(r => r.tipo_registro === 'entrenamiento');
    const suenos = registros.filter(r => r.tipo_registro === 'sueno');
    const comidas = registros.filter(r => r.tipo_registro === 'comida');

    // ── HÁBITO: Entrena en ayunas ──────────────────────────────────────────
    if (entrenos.length >= 5) {
      const entrenosAyunas = entrenos.filter(r => r.entreno_ayunas === true);
      const porcentajeAyunas = entrenosAyunas.length / entrenos.length;
      if (porcentajeAyunas >= 0.6) {
        await upsertHabito(usuarioId, 'entreno_ayunas_recurrente',
          `Entrena en ayunas en el ${Math.round(porcentajeAyunas * 100)}% de las sesiones registradas.`,
          { sesiones_totales: entrenos.length, sesiones_ayunas: entrenosAyunas.length, porcentaje: porcentajeAyunas }
        );
      }
    }

    // ── HÁBITO: Alta adherencia a fuerza ──────────────────────────────────
    if (entrenos.length >= 5) {
      const fuerza = entrenos.filter(r => r.entreno_tipo === 'fuerza');
      if (fuerza.length >= 3) {
        // Calcular semanas únicas
        const semanas = new Set(fuerza.map(r => {
          const d = new Date(r.fecha_evento || r.created_at);
          const startOfWeek = new Date(d);
          startOfWeek.setDate(d.getDate() - d.getDay());
          return startOfWeek.toISOString().split('T')[0];
        }));
        if (semanas.size >= 2) {
          await upsertHabito(usuarioId, 'fuerza_alta_adherencia',
            `Entrena fuerza de forma consistente — ${fuerza.length} sesiones en las últimas semanas.`,
            { sesiones_fuerza: fuerza.length, semanas_activas: semanas.size }
          );
        }
      }
    }

    // ── HÁBITO: Sueño consistente ──────────────────────────────────────────
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

    // ── HÁBITO: Sueño irregular ────────────────────────────────────────────
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

    // ── HÁBITO: Cena tardía recurrente ────────────────────────────────────
    const cenas = comidas.filter(r => r.comida_momento === 'cena' && r.nota_libre);
    if (cenas.length >= 3) {
      const cenasTardias = cenas.filter(r => {
        const hora = r.nota_libre?.match(/(\d{1,2}):(\d{2})/);
        if (hora) return parseInt(hora[1]) >= 21;
        return false;
      });
      if (cenasTardias.length / cenas.length >= 0.5) {
        await upsertHabito(usuarioId, 'cena_tardia_recurrente',
          `Cena frecuentemente después de las 21hs — en el ${Math.round(cenasTardias.length / cenas.length * 100)}% de los registros.`,
          { cenas_registradas: cenas.length, cenas_tardias: cenasTardias.length }
        );
      }
    }

    // ── HÁBITO: Energía baja un día específico de la semana ───────────────
    const registrosEnergia = registros.filter(r => r.energia !== null && r.energia <= 2);
    if (registrosEnergia.length >= 4) {
      const diasSemana = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
      const conteoXDia = {};
      registrosEnergia.forEach(r => {
        const dia = new Date(r.fecha_evento || r.created_at).getDay();
        conteoXDia[dia] = (conteoXDia[dia] || 0) + 1;
      });
      Object.entries(conteoXDia).forEach(async ([dia, count]) => {
        if (count >= 2) {
          await upsertHabito(usuarioId, `energia_baja_${diasSemana[dia]}`,
            `Energía baja se repite los ${diasSemana[dia]} — detectado ${count} veces en los últimos 30 días.`,
            { dia_semana: diasSemana[dia], ocurrencias: count }
          );
        }
      });
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
    .eq('estado', 'activo')
    .neq('confianza', 'descartado')
    .order('ultima_actualizacion', { ascending: false })
    .limit(8);

  if (!habitos || habitos.length === 0) return null;

  let texto = 'HÁBITOS DETECTADOS (patrones consolidados de esta persona):\n';
  habitos.forEach(h => {
    texto += `- ${h.descripcion} (confianza: ${h.confianza})\n`;
  });
  texto += 'Usá estos hábitos para personalizar observaciones y anticipar comportamientos — no para prescribir. IMPORTANTE: respondé siempre en texto plano, sin asteriscos, sin negrita, sin markdown de ningún tipo.';
  return texto;
}

// ─── OBRA SOCIAL ─────────────────────────────────────────────────────────────

// Detecta si el mensaje tiene intención de consulta sobre obra social
function esMensajeObraSocial(mensaje) {
  if (!mensaje) return false;
  const keywords = [
    'cubre', 'cobertura', 'obra social', 'pami', 'osseg', 'osde', 'ioma', 'prepaga',
    'prestador', 'médico', 'medico', 'especialista', 'farmacia', 'farmac',
    'turno', 'autorización', 'autorizacion', 'receta', 'medicamento', 'remedios',
    'laboratorio', 'análisis', 'análisis', 'ecografía', 'estudio', 'tomografía',
    'oftalmólogo', 'cardiólogo', 'traumatólogo', 'clínica', 'sanatorio',
    'internación', 'guardia', 'urgencia', 'traslado', 'ambulancia',
    'óptica', 'anteojos', 'audífono', 'prótesis', 'kinesiología',
    'porcentaje', 'reintegro', 'plan', 'afiliado', 'cartilla',
    'quién me atiende', 'donde me atiendo', 'dónde', 'donde'
  ];
  const msj = mensaje.toLowerCase();
  return keywords.some(k => msj.includes(k));
}

// Extrae el nombre de la obra social del contexto_base del usuario
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
  // Patrón genérico: buscar "Obra social: NOMBRE" o "NOMBRE (obra social)"
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
    // Agrupar por tipo
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

  texto += '\nIMPORTANTE: Usá esta información para responder preguntas de cobertura y prestadores con contexto personal. Nunca inventes datos que no estén acá. Si falta información, decilo honestamente.';

  return texto;
}

// ─── ONBOARDING AUTOMÁTICO ───────────────────────────────────────────────────

// Extrae datos del onboarding del historial de conversaciones
function extraerDatosOnboarding(historial) {
  if (!historial || historial.length === 0) return {};

  const texto = historial
    .map(h => `${h.rol}: ${h.mensaje}`)
    .join('\n')
    .toLowerCase();

  const datos = {};

  // Detectar nombre — buscar en respuestas del usuario después de que Sabi preguntó el nombre
  const mensajesUsuario = historial.filter(h => h.rol === 'user').map(h => h.mensaje);

  // Nombre: primera respuesta corta del usuario (1-3 palabras, no una oración)
  for (const msg of mensajesUsuario) {
    const limpio = msg.trim();
    const palabras = limpio.split(/\s+/);
    if (palabras.length >= 1 && palabras.length <= 4 && !limpio.includes('?') && !limpio.includes(',')) {
      // Probable nombre
      if (!datos.nombre && /^[a-záéíóúüñA-ZÁÉÍÓÚÜÑ\s]+$/.test(limpio)) {
        datos.nombre = limpio.split(' ').map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
      }
    }
  }

  // Edad: buscar número entre 10 y 110 en mensajes del usuario
  for (const msg of mensajesUsuario) {
    const match = msg.match(/\b(\d{2,3})\b/);
    if (match) {
      const num = parseInt(match[1]);
      if (num >= 10 && num <= 110 && !datos.edad) {
        datos.edad = num;
      }
    }
  }

  // Objetivo: último mensaje largo del usuario (más de 10 palabras) que no sea nombre ni edad
  for (const msg of [...mensajesUsuario].reverse()) {
    if (msg.split(/\s+/).length > 6 && !datos.objetivo) {
      datos.objetivo = msg.trim();
      break;
    }
  }

  return datos;
}

async function procesarOnboarding(userId, estado, historial, respuestaSabi) {
  try {
    const stage = estado.onboarding_stage;

    // Ya completo — no hacer nada
    if (stage === 'completo') return;

    const datos = extraerDatosOnboarding(historial);

    // Determinar nuevo stage según lo que tenemos
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
      nuevoStage = 'completo';
      updates.nombre = datos.nombre;
      // Detectar si es adulto mayor
      const modoUsuario = datos.edad >= 65 ? 'adulto_mayor' : 'adulto_activo';
      // Construir contexto_base básico
      const contextoBase = `Nombre: ${datos.nombre}
Edad: ${datos.edad} años
Objetivo principal: ${datos.objetivo}
Onboarding: completado automáticamente`;

      // Actualizar usuario
      await supabase
        .from('usuarios')
        .update({ nombre: updates.nombre, contexto_base: contextoBase })
        .eq('id', userId);

      // Actualizar estado
      await supabase
        .from('estado_usuario')
        .update({ onboarding_stage: 'completo', modo_usuario: modoUsuario })
        .eq('usuario_id', userId);

      console.log(`Onboarding completo: ${datos.nombre}, ${datos.edad} años, modo: ${modoUsuario}`);
      return;
    }

    // Actualizar stage y nombre si cambió
    if (nuevoStage !== stage) {
      const updateEstado = { onboarding_stage: nuevoStage };
      await supabase
        .from('estado_usuario')
        .update(updateEstado)
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

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'Sabi está vivo', version: '3.5.1' });
});

async function procesarChat(usuario, mensaje, res, imagenes) {
  try {
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

    // Validar media types de imágenes
    const imagenesValidas = tieneImagenes
      ? imagenes.filter(img => MEDIA_TYPES_VALIDOS.includes(img.tipo)).slice(0, 5)
      : null;

    let registrosExtraidos = [];
    let cantidadGuardada = 0;
    let errorExtraccion = false;
    let resultado = null;

    if (!enOnboarding && !esMensajeSistema) {
      resultado = await extraerRegistros(mensaje, imagenesValidas);
      registrosExtraidos = resultado.registros;
      errorExtraccion = resultado.error;
      cantidadGuardada = await guardarRegistros(user.id, mensaje, registrosExtraidos);
    }

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

    // Clasificar feedback de insight en segundo plano si el usuario respondió a uno reciente
    if (!enOnboarding && !esMensajeSistema && mensaje && mensaje.length > 2) {
      detectarYClasificarFeedback(user.id, mensaje);
    }

    const { data: estadoActualizado } = await supabase
      .from('estado_usuario')
      .select('*')
      .eq('usuario_id', user.id)
      .single();
    const estadoFinal = estadoActualizado || estado;

    const limiteHistorial = esAperturaDia ? 0 : 20;
    const { data: historial } = limiteHistorial > 0 ? await supabase
      .from('conversaciones')
      .select('rol, mensaje, fecha')
      .eq('usuario_id', user.id)
      .order('fecha', { ascending: false })
      .limit(limiteHistorial) : { data: [] };

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

    const { data: insightsPendientes } = await supabase
      .from('insights')
      .select('id, tipo_insight, regla_origen, confianza, contador_exposiciones')
      .eq('usuario_id', user.id)
      .eq('estado', 'pendiente')
      .order('created_at', { ascending: false })
      .limit(10);

    // Filtrar insights que no superaron 3 exposiciones y actualizar contador
    const insightsFiltrados = (insightsPendientes || []).filter(i => (i.contador_exposiciones || 0) < 3);
    if (insightsFiltrados.length > 0) {
      for (const insight of insightsFiltrados.slice(0, 3)) {
        await supabase
          .from('insights')
          .update({ contador_exposiciones: (insight.contador_exposiciones || 0) + 1 })
          .eq('id', insight.id);
      }
    }

    const contextoReciente = !enOnboarding ? await armarContextoReciente(user.id) : null;
    const estadoDiaResult = !enOnboarding ? await armarEstadoDia(user.id) : null;
    const estadoDia = estadoDiaResult ? estadoDiaResult.texto : null;
    const condicionCheckin = estadoDiaResult ? estadoDiaResult.condicionCheckin : false;
    const contextoHabitos = !enOnboarding ? await armarContextoHabitos(user.id) : null;

    // Determinar si corresponde disparar el check-in
    // No disparar si ya hubo checkin hoy
    let triggerCheckin = false;
    if (!enOnboarding && !esMensajeSistema && condicionCheckin) {
      const inicioHoyCheck = getInicioHoyArgentina();
      const inicioMananaCheck = getInicioMananaArgentina();
      const { data: checkinHoy } = await supabase
        .from('registros')
        .select('id')
        .eq('usuario_id', user.id)
        .eq('origen', 'checkin')
        .gte('fecha_evento', inicioHoyCheck.toISOString())
        .lt('fecha_evento', inicioMananaCheck.toISOString())
        .limit(1);
      triggerCheckin = !checkinHoy || checkinHoy.length === 0;
    }

    // Consulta obra social solo si el mensaje lo amerita y el usuario tiene una cargada
    let contextoObraSocial = null;
    if (!enOnboarding && !esMensajeSistema && esMensajeObraSocial(mensaje)) {
      const obraSocial = extraerObraSocial(user.contexto_base);
      if (obraSocial) {
        contextoObraSocial = await consultarObraSocial(obraSocial);
      }
    }

    let systemFinal = enOnboarding ? SABI_ONBOARDING : SABI_SYSTEM;

    if (!enOnboarding) {
      const fechaCompleta = new Date().toLocaleString('es-AR', {
        timeZone: 'America/Argentina/Buenos_Aires',
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
      systemFinal += `\n\nCONTEXTO TEMPORAL: Ahora son las ${fechaCompleta} (hora Argentina). Usá esta fecha y hora para distinguir qué pasó hoy, qué pasó ayer, y qué momento del día es ahora.`;
    }

    if (!enOnboarding && user.contexto_base) {
      systemFinal += `\n\nPERFIL DEL USUARIO:\n${user.contexto_base}`;
    }

    if (!enOnboarding && estadoFinal.modo_usuario) {
      systemFinal += `\n\nMODO: ${estadoFinal.modo_usuario}`;
      if (estadoFinal.modo_usuario === 'adulto_mayor') {
        systemFinal += '\nEste usuario es un adulto mayor. Tono más simple, más cálido, más pausado. Sin tecnicismos sin explicar.';
      }
    }

    if (!enOnboarding && estadoFinal.madurez_sabi) {
      const madurezTexto = {
        'escucha': 'Estás en etapa de escucha — primeros días. Acusá recibo, respondé consultas directas, no des insights proactivos todavía.',
        'tendencia_temprana': 'Tenés una semana de datos. Podés señalar tendencias tentativas con honestidad sobre la certeza.',
        'patron_confirmado': 'Tenés patrones confirmados. Podés dar insights con confianza y hacer sugerencias concretas basadas en correlaciones reales.',
        'profundo': 'Conocés bien el ritmo de esta persona. Podés detectar desvíos del patrón habitual y hacer conexiones sutiles entre pilares.'
      };
      systemFinal += `\n\nETAPA ACTUAL: ${madurezTexto[estadoFinal.madurez_sabi]}`;
    }

    if (!enOnboarding && contextoReciente) {
      systemFinal += `\n\n${contextoReciente}`;
    }

    if (!enOnboarding && contextoHabitos) {
      systemFinal += `\n\n${contextoHabitos}`;
    }

    if (!enOnboarding && estadoDia) {
      systemFinal += `\n\n${estadoDia}`;
    }

    if (!enOnboarding && registrosExtraidos.length > 0) {
      systemFinal += `\n\nDATOS REGISTRADOS EN ESTE MENSAJE (${registrosExtraidos.length} registro/s):\n${JSON.stringify(registrosExtraidos, null, 2)}`;
    }

    // Advertencia si el usuario intentó registrar pero no se guardó nada
    if (!enOnboarding && !esMensajeSistema && cantidadGuardada === 0 && (errorExtraccion || (mensaje && mensaje.length > 20))) {
      const esTimeout = resultado && resultado.timeout;
      systemFinal += esTimeout
        ? '\n\nADVERTENCIA INTERNA: La extracción tardó demasiado y no se guardó ningún registro. El mensaje puede haber sido demasiado largo o pesado. Decile al usuario algo como "Recibí tu mensaje pero hubo un problema al procesarlo — ¿podés separarlo en partes más cortas o enviarlo sin imágenes?" Sin decir "anotado" ni "registrado".'
        : '\n\nADVERTENCIA INTERNA: No se pudo guardar ningún registro estructurado. Si el usuario intentó registrar algo, no digas "anotado", "registrado" ni "lo sumo". Respondé naturalmente sin afirmar que quedó guardado.';
    }

    if (!enOnboarding && insightsFiltrados && insightsFiltrados.length > 0) {
      systemFinal += '\n\nSEÑALES DETECTADAS (mencioná solo si es relevante y natural):\n';
      insightsFiltrados.slice(0, 3).forEach(i => {
        // Incluir ID explícito para que el modelo pueda taggear cuál usó
        systemFinal += `- [id:${i.id}] ${i.tipo_insight}: ${i.regla_origen} (confianza: ${i.confianza})\n`;
      });
    }

    if (!enOnboarding && contextoObraSocial) {
      systemFinal += `\n\n${contextoObraSocial}`;
    }

    if (!enOnboarding && eventosProximos && eventosProximos.length > 0) {
      systemFinal += '\n\nEVENTOS PRÓXIMOS:\n';
      eventosProximos.forEach(e => {
        const fecha = new Date(e.fecha_evento).toLocaleDateString('es-AR');
        const diasRestantes = Math.ceil((new Date(e.fecha_evento) - hoy) / (1000 * 60 * 60 * 24));
        systemFinal += `- ${e.titulo}: ${fecha} (en ${diasRestantes} días) — ${e.descripcion}\n`;
      });
    }

    if (!enOnboarding) {
      // Regla de cierre del día y uso del contexto
      systemFinal += '\n\nREGLA DE USO DEL CONTEXTO: El ESTADO DEL DÍA tiene prioridad absoluta para saber qué ya pasó hoy y qué sigue. Nunca preguntes por algo que ya figura como registrado. Si hay múltiples registros nuevos, acusá recibo brevemente. Si es adulto mayor, no anticipes actividad física.';

      // Regla de control de preguntas — reforzada al final del system para que no se diluya
      if (estadoDia) {
        const puedePreg = estadoDia.includes('Puede preguntar: sí');
        const accion = estadoDia.match(/Acción recomendada: (\w+)/)?.[1] || '';
        const proximo = estadoDia.match(/Próximo momento habilitado: (\w+)/)?.[1] || 'ninguno';

        if (accion === 'dia_cerrado') {
          systemFinal += '\n\nINSTRUCCIÓN FINAL OBLIGATORIA: El día está cerrado (cena registrada). Terminá con "Buen descanso." o "Buenas noches." SIN abrir ninguna pregunta. Esto no es negociable.';
        } else if (!puedePreg || proximo === 'ninguno') {
          systemFinal += `\n\nINSTRUCCIÓN FINAL OBLIGATORIA: No hay ningún momento habilitado para preguntar ahora. La ventana horaria no está abierta. Cerrá con algo breve y cálido SIN hacer ninguna pregunta — ni sobre almuerzo, ni sobre ninguna comida, ni sobre ningún otro evento. Esto no es negociable.`;
        } else if (puedePreg && proximo && proximo !== 'ninguno') {
          systemFinal += `\n\nINSTRUCCIÓN FINAL OBLIGATORIA: Si hacés una pregunta, debe ser ÚNICAMENTE sobre "${proximo}". No preguntes por ningún otro evento. Una sola pregunta máximo.`;
        }
      }
    }

    const mensajesPrevios = (historial || [])
      .reverse()
      .filter(h => ['user', 'assistant'].includes(h.rol))
      .map(h => ({ role: h.rol, content: h.mensaje }));

    mensajesPrevios.push({ role: 'user', content: mensaje || '[imágenes]' });

    if (!esMensajeSistema) {
      await supabase.from('conversaciones').insert([{
        usuario_id: user.id,
        rol: 'user',
        mensaje: tieneImagenes ? '[imagen' + (imagenes.length > 1 ? 'es' : '') + ']' + (mensaje ? ': ' + mensaje : '') : mensaje
      }]);
    }

    let response;
    if (imagenesValidas && imagenesValidas.length > 0) {
      response = await generarRespuestaConImagenes(systemFinal, mensajesPrevios, mensaje, imagenesValidas);
    } else {
      response = await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 500,
        system: systemFinal,
        messages: mensajesPrevios,
      });
    }

    let respuestaRaw = response.content[0].text;

    // Parsear tag [INSIGHT_ID: xxx] — acepta números y UUIDs
    const insightTagMatch = respuestaRaw.match(/\[INSIGHT_ID:\s*([a-zA-Z0-9-]+)\]/i);
    let respuesta = respuestaRaw.replace(/\[INSIGHT_ID:\s*[a-zA-Z0-9-]+\]\s*/gi, '').trimEnd();
    const insightUsadoId = insightTagMatch ? insightTagMatch[1] : null;

    // Guardrail determinístico — si el código dice que no hay nada para preguntar
    // y el modelo igual preguntó, reemplazar por respuesta segura
    respuesta = aplicarGuardrailEstadoDia(respuesta, estadoDiaResult);

    await supabase.from('conversaciones').insert([{ usuario_id: user.id, rol: 'assistant', mensaje: respuesta }]);

    // Actualizar ultimo_mensaje_at y, si el modelo usó un insight, registrarlo
    const updateEstadoPayload = { ultimo_mensaje_at: new Date().toISOString() };
    if (insightUsadoId) {
      updateEstadoPayload.ultimo_insight_mostrado_id = insightUsadoId;
      updateEstadoPayload.ultimo_insight_mostrado_at = new Date().toISOString();
      console.log(`Insight ${insightUsadoId} marcado como mostrado`);
    }
    await supabase.from('estado_usuario').update(updateEstadoPayload).eq('usuario_id', user.id);

    // Procesar onboarding automático si el usuario todavía no completó
    if (enOnboarding) {
      const historialCompleto = await supabase
        .from('conversaciones')
        .select('rol, mensaje')
        .eq('usuario_id', user.id)
        .order('fecha', { ascending: true })
        .limit(30);
      await procesarOnboarding(user.id, estadoFinal, historialCompleto.data || [], respuesta);
    }

    const responsePayload = {
      respuesta,
      usuario: user.nombre,
      onboarding: enOnboarding,
      modo: estadoFinal.modo_usuario,
      madurez: estadoFinal.madurez_sabi,
      registros_guardados: cantidadGuardada,
      insights_pendientes: insightsFiltrados ? insightsFiltrados.length : 0,
      trigger_checkin: triggerCheckin || false
    };

    // Si trigger_checkin, incluir las preguntas para que el frontend las muestre
    if (triggerCheckin) {
      responsePayload.checkin = {
        preguntas: [
          { id: 1, pregunta: '¿Cómo estuvo tu energía hoy?', opciones: ['Alta', 'Normal', 'Baja', 'Muy baja'] },
          { id: 2, pregunta: '¿Cómo te sentiste por dentro?', opciones: ['Bien', 'Regular', 'Pesado', 'Ansioso'] },
          { id: 3, pregunta: '¿Estuviste con gente que te hace bien?', opciones: ['Sí, estuvo bueno', 'Algo, poco', 'Solo todo el día'] },
          { id: 4, pregunta: '¿Ya estás soltando el día?', opciones: ['Sí, desconectando', 'Más o menos', 'No, sigo en modo trabajo'] },
          { id: 5, pregunta: '¿Cómo estuvo el cuerpo?', opciones: ['Liviano', 'Normal', 'Pesado o cansado', 'Algo molesto'] },
          { id: 6, pregunta: '¿Algo del día que quieras dejar anotado?', opciones: ['Sí, te cuento', 'No, ya está'], opcional: true }
        ]
      };
    }

    res.json(responsePayload);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}

app.get('/chat/:usuario/:mensaje', async (req, res) => {
  await procesarChat(req.params.usuario, req.params.mensaje, res, null);
});

app.post('/chat', async (req, res) => {
  const { usuario, mensaje, imagenes } = req.body;
  if (!usuario || (!mensaje && (!imagenes || imagenes.length === 0))) {
    return res.status(400).json({ error: 'Faltan usuario y mensaje o imágenes' });
  }
  await procesarChat(usuario, mensaje || '', res, imagenes ? imagenes.slice(0, 5) : null);
});

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
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/checkin/:usuario', async (req, res) => {
  try {
    const { data: user } = await supabase.from('usuarios').select('*').eq('telefono', req.params.usuario).single();
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({
      mensaje: `¿Cómo terminó el día, ${user.nombre}?`,
      preguntas: [
        { id: 1, pregunta: '¿Cómo estuvo tu energía hoy?', opciones: ['Alta', 'Normal', 'Baja', 'Muy baja'] },
        { id: 2, pregunta: '¿Cómo te sentiste por dentro?', opciones: ['Bien', 'Regular', 'Pesado', 'Ansioso'] },
        { id: 3, pregunta: '¿Estuviste con gente que te hace bien?', opciones: ['Sí, estuvo bueno', 'Algo, poco', 'Solo todo el día'] },
        { id: 4, pregunta: '¿Ya estás soltando el día?', opciones: ['Sí, desconectando', 'Más o menos', 'No, sigo en modo trabajo'] },
        { id: 5, pregunta: '¿Cómo estuvo el cuerpo?', opciones: ['Liviano', 'Normal', 'Pesado o cansado', 'Algo molesto'] },
        { id: 6, pregunta: '¿Algo del día que quieras dejar anotado?', opciones: ['Sí, te cuento', 'No, ya está'], opcional: true }
      ]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// ─── POST /checkin ───────────────────────────────────────────────────────────
// Recibe las respuestas del check-in de cierre y las guarda como registros
// estructurados. No depende del extractor — los datos ya vienen limpios.

const MAPA_ENERGIA_CHECKIN = {
  'Alta': 5, 'Normal': 3, 'Baja': 2, 'Muy baja': 1
};

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
    for (const registro of registrosCheckin) {
      const { error } = await supabase.from('registros').insert([registro]);
      if (!error) guardados++;
    }

    const resumenTexto = respuestas
      .filter(r => r.valor)
      .map(r => `p${r.id}: ${r.valor}`)
      .join(' | ');
    await supabase.from('conversaciones').insert([{
      usuario_id: user.id, rol: 'user',
      mensaje: `[check-in cierre] ${resumenTexto}`
    }]);

    res.json({ ok: true, registros_guardados: guardados });
  } catch (error) {
    console.error('Error guardando check-in:', error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sabi escuchando en puerto ${PORT}`));
