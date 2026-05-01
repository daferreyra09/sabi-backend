const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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
- Con adultos mayores: tono más pausado, más cálido, más simple. Nada técnico sin explicar.
Lo que nunca hacés:
- Nunca reemplazás al médico
- Nunca das diagnósticos
- Nunca das más de una sugerencia a la vez
- Nunca repetís el mismo mensaje dos veces seguidas
- Nunca hablás más de 1-2 veces proactivo por día
- Nunca preguntás por el desayuno a alguien que hace ayuno intermitente
Cuando alguien te saluda por primera vez en el día, no respondas con un saludo genérico. Preguntá algo concreto relacionado a su contexto. Con adultos mayores, algo simple: cómo amaneció, cómo está el cuerpo, si descansó bien.`;

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
  "hay_registro": true o false,
  "tipo_registro": "sueno" | "entrenamiento" | "comida" | "estado" | "sintoma" | "evento" | null,
  "energia": número 1-5 o null,
  "nota_libre": "texto corto descriptivo o null",
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

Reglas estrictas:
- Si el mensaje no contiene ningún dato de salud registrable, devolvé hay_registro: false y todo lo demás null.
- Nunca inventes datos. Si no está en el mensaje, es null.
- energia siempre 1-5 o null. Nunca texto.
- tipo_registro solo puede ser uno de los valores listados.
- entreno_tipo y comida_momento solo pueden ser los valores listados exactos.
- nota_libre es un resumen breve de lo que dijo el usuario, siempre en tercera persona.`;

const TIPOS_REGISTRO_VALIDOS = ['sueno', 'entrenamiento', 'comida', 'estado', 'sintoma', 'evento'];
const TIPOS_ENTRENO_VALIDOS = ['fuerza', 'cardio', 'mixto', 'movilidad', 'descanso_activo'];
const MOMENTOS_COMIDA_VALIDOS = ['desayuno', 'almuerzo', 'merienda', 'cena', 'snack'];

function validarRango(valor, min, max) {
  if (valor === null || valor === undefined) return null;
  const num = Number(valor);
  if (isNaN(num) || num < min || num > max) return null;
  return num;
}

function validarEnum(valor, permitidos) {
  if (!valor || !permitidos.includes(valor)) return null;
  return valor;
}

function validarExtraccion(json) {
  return {
    hay_registro: json.hay_registro === true,
    tipo_registro: validarEnum(json.tipo_registro, TIPOS_REGISTRO_VALIDOS),
    energia: validarRango(json.energia, 1, 5),
    nota_libre: typeof json.nota_libre === 'string' ? json.nota_libre.slice(0, 300) : null,
    sueno_calidad: validarRango(json.sueno_calidad, 1, 5),
    sueno_duracion_hs: validarRango(json.sueno_duracion_hs, 0, 24),
    sueno_despertares: validarRango(json.sueno_despertares, 0, 20),
    sueno_hora_dormir: typeof json.sueno_hora_dormir === 'string' ? json.sueno_hora_dormir : null,
    sueno_hora_despertar: typeof json.sueno_hora_despertar === 'string' ? json.sueno_hora_despertar : null,
    entreno_tipo: validarEnum(json.entreno_tipo, TIPOS_ENTRENO_VALIDOS),
    entreno_percepcion: validarRango(json.entreno_percepcion, 1, 5),
    entreno_ayunas: typeof json.entreno_ayunas === 'boolean' ? json.entreno_ayunas : null,
    comida_momento: validarEnum(json.comida_momento, MOMENTOS_COMIDA_VALIDOS),
    comida_descripcion: typeof json.comida_descripcion === 'string' ? json.comida_descripcion.slice(0, 500) : null,
    sintoma_tipo: typeof json.sintoma_tipo === 'string' ? json.sintoma_tipo.slice(0, 200) : null,
    sintoma_intensidad: validarRango(json.sintoma_intensidad, 1, 5)
  };
}

async function extraerRegistro(mensaje) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 300,
      system: SABI_EXTRACTOR,
      messages: [{ role: 'user', content: mensaje }]
    });

    let texto = response.content[0].text.trim();
    texto = texto.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    const json = JSON.parse(texto);
    return validarExtraccion(json);

  } catch (error) {
    console.error('Error al extraer:', error.message);
    return { hay_registro: false };
  }
}

async function guardarRegistro(usuarioId, mensaje, extraccion) {
  if (!extraccion.hay_registro || !extraccion.tipo_registro) {
    if (extraccion.hay_registro && !extraccion.tipo_registro) {
      console.warn('Advertencia: hay_registro true pero tipo_registro null — no se guarda');
    }
    return false;
  }

  const { error } = await supabase.from('registros').insert([{
    usuario_id: usuarioId,
    tipo_registro: extraccion.tipo_registro,
    mensaje_original: mensaje,
    origen: 'chat',
    energia: extraccion.energia,
    nota_libre: extraccion.nota_libre,
    sueno_calidad: extraccion.sueno_calidad,
    sueno_duracion_hs: extraccion.sueno_duracion_hs,
    sueno_despertares: extraccion.sueno_despertares,
    sueno_hora_dormir: extraccion.sueno_hora_dormir,
    sueno_hora_despertar: extraccion.sueno_hora_despertar,
    entreno_tipo: extraccion.entreno_tipo,
    entreno_percepcion: extraccion.entreno_percepcion,
    entreno_ayunas: extraccion.entreno_ayunas,
    comida_momento: extraccion.comida_momento,
    comida_descripcion: extraccion.comida_descripcion,
    sintoma_tipo: extraccion.sintoma_tipo,
    sintoma_intensidad: extraccion.sintoma_intensidad
  }]);

  if (error) {
    console.error('Error guardando registro:', error.message);
    return false;
  }

  return true;
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
    usuario_id: usuarioId,
    tipo_insight: tipoInsight,
    regla_origen: reglaOrigen,
    evidencia_json: evidencia,
    confianza: 'tentativo',
    estado: 'pendiente'
  }]);

  if (error) {
    console.error('Error creando insight:', error.message);
  } else {
    console.log(`Insight creado: ${tipoInsight} / ${reglaOrigen}`);
  }
}

async function evaluarSenales(usuarioId) {
  const hace7dias = new Date();
  hace7dias.setDate(hace7dias.getDate() - 7);

  const { data: registros } = await supabase
    .from('registros')
    .select('tipo_registro, energia, sueno_calidad, created_at')
    .eq('usuario_id', usuarioId)
    .gte('created_at', hace7dias.toISOString())
    .order('created_at', { ascending: true });

  if (!registros || registros.length === 0) return;

  // Regla 1 — Sueño bajo repetido
  const registrosSuenoBajo = registros.filter(r =>
    r.tipo_registro === 'sueno' && r.sueno_calidad !== null && r.sueno_calidad <= 2
  );

  if (registrosSuenoBajo.length >= 3) {
    await crearInsight(usuarioId, 'sueno_recuperacion', 'sueno_bajo_repetido_7d', {
      dias_analizados: 7,
      registros_sueno_bajo: registrosSuenoBajo.length,
      umbral: 2
    });
  }

  // Regla 2 — Energía baja en días distintos
  const diasConEnergiaBaja = new Set();
  registros.forEach(r => {
    if (r.energia !== null && r.energia <= 2) {
      const dia = new Date(r.created_at).toISOString().split('T')[0];
      diasConEnergiaBaja.add(dia);
    }
  });

  if (diasConEnergiaBaja.size >= 3) {
    await crearInsight(usuarioId, 'energia_sostenida', 'energia_baja_repetida_7d', {
      dias_analizados: 7,
      dias_con_energia_baja: diasConEnergiaBaja.size,
      umbral: 2
    });
  }

  // Regla 3 — Correlación sueño bajo → energía baja
  const registrosPorDia = {};
  registros.forEach(r => {
    const dia = new Date(r.created_at).toISOString().split('T')[0];
    if (!registrosPorDia[dia]) registrosPorDia[dia] = [];
    registrosPorDia[dia].push(r);
  });

  let correlaciones = 0;
  const diasOrdenados = Object.keys(registrosPorDia).sort();

  diasOrdenados.forEach((dia, index) => {
    const registrosDia = registrosPorDia[dia];
    const tieneSuenoBajo = registrosDia.some(r =>
      r.tipo_registro === 'sueno' && r.sueno_calidad !== null && r.sueno_calidad <= 2
    );

    if (tieneSuenoBajo) {
      // Buscar energía baja el mismo día o el día siguiente
      const diaSiguiente = diasOrdenados[index + 1];
      const registrosMismoDia = registrosDia;
      const registrosDiaSiguiente = diaSiguiente ? registrosPorDia[diaSiguiente] : [];

      const energiaBaja = [...registrosMismoDia, ...registrosDiaSiguiente].some(r =>
        r.energia !== null && r.energia <= 2
      );

      if (energiaBaja) correlaciones++;
    }
  });

  if (correlaciones >= 2) {
    await crearInsight(usuarioId, 'sueno_energia', 'sueno_bajo_energia_baja_7d', {
      dias_analizados: 7,
      correlaciones_detectadas: correlaciones,
      umbral_sueno: 2,
      umbral_energia: 2
    });
  }
}

app.get('/', (req, res) => {
  res.json({ status: 'Sabi está vivo', version: '2.4.0' });
});

async function procesarChat(usuario, mensaje, res) {
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
        .insert([{
          usuario_id: user.id,
          onboarding_stage: 'nuevo',
          modo_usuario: 'general',
          madurez_sabi: 'escucha'
        }])
        .select()
        .single();
      estado = nuevoEstado;
    }

    const enOnboarding = estado.onboarding_stage !== 'completo';

    // Llamada 1 — extracción
    let extraccion = { hay_registro: false };
    let registroGuardado = false;

    if (!enOnboarding) {
      extraccion = await extraerRegistro(mensaje);
      registroGuardado = await guardarRegistro(user.id, mensaje, extraccion);
    }

    // Motor de señales — aislado, no bloquea respuesta
    if (registroGuardado) {
      try {
        await evaluarSenales(user.id);
      } catch (error) {
        console.error('Error evaluando señales:', error.message);
      }
    }

    const { data: historial } = await supabase
      .from('conversaciones')
      .select('rol, mensaje, fecha')
      .eq('usuario_id', user.id)
      .order('fecha', { ascending: false })
      .limit(20);

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

    // Insights pendientes para informar al modelo
    const { data: insightsPendientes } = await supabase
      .from('insights')
      .select('tipo_insight, regla_origen, evidencia_json, confianza')
      .eq('usuario_id', user.id)
      .eq('estado', 'pendiente')
      .order('created_at', { ascending: false })
      .limit(3);

    let systemFinal = enOnboarding ? SABI_ONBOARDING : SABI_SYSTEM;

    if (!enOnboarding && user.contexto_base) {
      systemFinal += `\n\nPERFIL DEL USUARIO:\n${user.contexto_base}`;
    }

    if (!enOnboarding && estado.modo_usuario) {
      systemFinal += `\n\nMODO: ${estado.modo_usuario}`;
      if (estado.modo_usuario === 'adulto_mayor') {
        systemFinal += '\nEste usuario es un adulto mayor. Tono más simple, más cálido, más pausado. Sin tecnicismos sin explicar.';
      }
    }

    if (!enOnboarding && estado.madurez_sabi) {
      const madurezTexto = {
        'escucha': 'Estás en etapa de escucha — primeros días. Acusá recibo, respondé consultas directas, no des insights proactivos todavía.',
        'tendencia_temprana': 'Tenés algunos días de datos. Podés señalar tendencias tentativas pero con honestidad sobre la certeza.',
        'patron_confirmado': 'Tenés patrones confirmados. Podés dar insights con confianza y hacer sugerencias concretas.',
        'profundo': 'Conocés bien el ritmo de esta persona. Podés detectar desvíos y hacer conexiones sutiles entre pilares.'
      };
      systemFinal += `\n\nETAPA ACTUAL: ${madurezTexto[estado.madurez_sabi]}`;
    }

    if (!enOnboarding && extraccion.hay_registro) {
      systemFinal += `\n\nDATO REGISTRADO EN ESTE MENSAJE: ${JSON.stringify(extraccion)}`;
    }

    if (!enOnboarding && insightsPendientes && insightsPendientes.length > 0) {
      systemFinal += '\n\nSEÑALES DETECTADAS (para tu conocimiento — mencioná solo si es relevante y natural en la conversación):\n';
      insightsPendientes.forEach(i => {
        systemFinal += `- ${i.tipo_insight}: ${i.regla_origen} (confianza: ${i.confianza})\n`;
      });
    }

    if (!enOnboarding && eventosProximos && eventosProximos.length > 0) {
      systemFinal += '\n\nEVENTOS PRÓXIMOS:\n';
      eventosProximos.forEach(e => {
        const fecha = new Date(e.fecha_evento).toLocaleDateString('es-AR');
        const diasRestantes = Math.ceil((new Date(e.fecha_evento) - hoy) / (1000 * 60 * 60 * 24));
        systemFinal += `- ${e.titulo}: ${fecha} (en ${diasRestantes} días) — ${e.descripcion}\n`;
      });
      systemFinal += 'Mencioná estos eventos solo cuando sea relevante.';
    }

    const mensajesPrevios = (historial || [])
      .reverse()
      .map(h => ({ role: h.rol, content: h.mensaje }));

    mensajesPrevios.push({ role: 'user', content: mensaje });

    await supabase.from('conversaciones').insert([{
      usuario_id: user.id,
      rol: 'user',
      mensaje: mensaje
    }]);

    // Llamada 2 — respuesta
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      system: systemFinal,
      messages: mensajesPrevios,
    });

    const respuesta = response.content[0].text;

    await supabase.from('conversaciones').insert([{
      usuario_id: user.id,
      rol: 'assistant',
      mensaje: respuesta
    }]);

    await supabase
      .from('estado_usuario')
      .update({ ultimo_mensaje_at: new Date().toISOString() })
      .eq('usuario_id', user.id);

    res.json({
      respuesta,
      usuario: user.nombre,
      onboarding: enOnboarding,
      modo: estado.modo_usuario,
      madurez: estado.madurez_sabi,
      registro_guardado: registroGuardado,
      insights_pendientes: insightsPendientes ? insightsPendientes.length : 0
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}

app.get('/chat/:usuario/:mensaje', async (req, res) => {
  const { usuario, mensaje } = req.params;
  await procesarChat(usuario, mensaje, res);
});

app.post('/chat', async (req, res) => {
  const { usuario, mensaje } = req.body;
  if (!usuario || !mensaje) {
    return res.status(400).json({ error: 'Faltan usuario o mensaje' });
  }
  await procesarChat(usuario, mensaje, res);
});

app.get('/checkin/:usuario', async (req, res) => {
  const { usuario } = req.params;
  try {
    let { data: user } = await supabase
      .from('usuarios')
      .select('*')
      .eq('telefono', usuario)
      .single();

    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const checkin = {
      mensaje: `¿Cómo terminó el día, ${user.nombre}?`,
      preguntas: [
        { id: 1, pregunta: '¿Cómo estuvo tu energía hoy?', opciones: ['Alta', 'Normal', 'Baja', 'Muy baja'], pilar: 'foco_energia' },
        { id: 2, pregunta: '¿Cómo te sentiste por dentro?', opciones: ['Bien', 'Regular', 'Pesado', 'Ansioso'], pilar: 'estres_recuperacion' },
        { id: 3, pregunta: '¿Estuviste con gente que te hace bien?', opciones: ['Sí, estuvo bueno', 'Algo, poco', 'Solo todo el día'], pilar: 'contexto_vida' },
        { id: 4, pregunta: '¿Ya estás soltando el día?', opciones: ['Sí, desconectando', 'Más o menos', 'No, sigo en modo trabajo'], pilar: 'estres_recuperacion' },
        { id: 5, pregunta: '¿Cómo estuvo el cuerpo?', opciones: ['Liviano', 'Normal', 'Pesado o cansado', 'Algo molesto'], pilar: 'movimiento' },
        { id: 6, pregunta: '¿Algo del día que quieras dejar anotado?', opciones: ['Sí, te cuento', 'No, ya está'], pilar: 'contexto_vida', opcional: true }
      ]
    };

    res.json(checkin);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sabi escuchando en puerto ${PORT}`);
});
