const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

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
- Sin markdown — nunca uses asteriscos, negrita, cursiva ni bullets. Solo texto plano.
- Con adultos mayores: tono más pausado, más cálido, más simple. Nada técnico sin explicar.
Lo que nunca hacés:
- Nunca reemplazás al médico
- Nunca das diagnósticos
- Nunca das más de una sugerencia a la vez
- Nunca repetís el mismo mensaje dos veces seguidas
- Nunca hablás más de 1-2 veces proactivo por día
- Nunca preguntás por el desayuno a alguien que hace ayuno intermitente
- Si el mensaje empieza con "APERTURA_DIA:": es la primera apertura del día. Tu respuesta DEBE empezar con "Hola [nombre]." seguido de UNA pregunta concreta basada en el momento del día y los registros disponibles. Usá esta lógica de horario: antes de las 13:00 → sueño o entrenamiento; entre 13:00 y 16:00 → almuerzo o energía; entre 16:00 y 20:00 → merienda o entrenamiento tarde; después de las 20:00 → cena o cierre. Nunca preguntes por algo que ya está en REGISTROS DE HOY.
- Si el mensaje es "reapertura_del_dia": no saludes. Preguntá directamente algo relevante según la hora y lo que falta registrar.
- Si el usuario registró la cena (comida_momento = cena) O son más de las 21:00 Y ya registró almuerzo Y ya registró cena: cerrá con "Buen descanso." o "Buenas noches." Sin abrir nuevas preguntas. En ningún otro caso cierres el día — registrar merienda, snack o entrenamiento no es señal de cierre.
- Si recibís imágenes: describí lo que ves en términos de salud y acusá recibo de los datos extraídos.`;

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

Reglas estrictas:
- Si no hay ningún dato de salud registrable: devolvé {"registros": []}
- Mensajes que empiezan con "APERTURA_DIA:" y el mensaje "reapertura_del_dia" no son registros. Devolvé {"registros": []}
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

function validarRegistro(obj) {
  const tipo = validarEnum(obj.tipo_registro, TIPOS_REGISTRO_VALIDOS);
  if (!tipo) return null;
  return {
    tipo_registro: tipo,
    energia: validarRango(obj.energia, 1, 5),
    nota_libre: typeof obj.nota_libre === 'string' ? obj.nota_libre.slice(0, 300) : null,
    sueno_calidad: validarRango(obj.sueno_calidad, 1, 5),
    sueno_duracion_hs: validarRango(obj.sueno_duracion_hs, 0, 24),
    sueno_despertares: validarRango(obj.sueno_despertares, 0, 20),
    sueno_hora_dormir: typeof obj.sueno_hora_dormir === 'string' ? obj.sueno_hora_dormir : null,
    sueno_hora_despertar: typeof obj.sueno_hora_despertar === 'string' ? obj.sueno_hora_despertar : null,
    entreno_tipo: validarEnum(obj.entreno_tipo, TIPOS_ENTRENO_VALIDOS),
    entreno_percepcion: validarRango(obj.entreno_percepcion, 1, 5),
    entreno_ayunas: typeof obj.entreno_ayunas === 'boolean' ? obj.entreno_ayunas : null,
    comida_momento: validarEnum(obj.comida_momento, MOMENTOS_COMIDA_VALIDOS),
    comida_descripcion: typeof obj.comida_descripcion === 'string' ? obj.comida_descripcion.slice(0, 500) : null,
    sintoma_tipo: typeof obj.sintoma_tipo === 'string' ? obj.sintoma_tipo.slice(0, 200) : null,
    sintoma_intensidad: validarRango(obj.sintoma_intensidad, 1, 5)
  };
}

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
      contenidoUsuario = mensaje;
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      system: SABI_EXTRACTOR,
      messages: [{ role: 'user', content: contenidoUsuario }]
    });

    let texto = response.content[0].text.trim();
    texto = texto.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const json = JSON.parse(texto);
    if (!Array.isArray(json.registros)) return [];
    return json.registros.map(r => validarRegistro(r)).filter(r => r !== null);
  } catch (error) {
    console.error('Error al extraer:', error.message);
    return [];
  }
}

async function guardarRegistros(usuarioId, mensaje, registros) {
  if (!registros || registros.length === 0) return 0;
  let guardados = 0;
  for (const registro of registros) {
    const { error } = await supabase.from('registros').insert([{
      usuario_id: usuarioId,
      tipo_registro: registro.tipo_registro,
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
    }]);
    if (error) {
      console.error(`Error guardando registro ${registro.tipo_registro}:`, error.message);
    } else {
      guardados++;
    }
  }
  return guardados;
}

// Calcula y actualiza madurez basada en días con datos y cantidad de registros
async function actualizarMadurez(usuarioId) {
  try {
    const { data: registros } = await supabase
      .from('registros')
      .select('created_at')
      .eq('usuario_id', usuarioId);

    if (!registros) return;

    const cantidadRegistros = registros.length;
    const diasConDatos = new Set(
      registros.map(r => new Date(r.created_at).toISOString().split('T')[0])
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
      .update({
        madurez_sabi: nuevaMadurez,
        cantidad_registros: cantidadRegistros,
        dias_con_datos: diasConDatos
      })
      .eq('usuario_id', usuarioId);

  } catch (error) {
    console.error('Error actualizando madurez:', error.message);
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

  const registrosSuenoBajo = registros.filter(r =>
    r.tipo_registro === 'sueno' && r.sueno_calidad !== null && r.sueno_calidad <= 2
  );
  if (registrosSuenoBajo.length >= 3) {
    await crearInsight(usuarioId, 'sueno_recuperacion', 'sueno_bajo_repetido_7d', {
      dias_analizados: 7, registros_sueno_bajo: registrosSuenoBajo.length, umbral: 2
    });
  }

  const diasConEnergiaBaja = new Set();
  registros.forEach(r => {
    if (r.energia !== null && r.energia <= 2) {
      diasConEnergiaBaja.add(new Date(r.created_at).toISOString().split('T')[0]);
    }
  });
  if (diasConEnergiaBaja.size >= 3) {
    await crearInsight(usuarioId, 'energia_sostenida', 'energia_baja_repetida_7d', {
      dias_analizados: 7, dias_con_energia_baja: diasConEnergiaBaja.size, umbral: 2
    });
  }

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
      const diaSiguiente = diasOrdenados[index + 1];
      const registrosDiaSiguiente = diaSiguiente ? registrosPorDia[diaSiguiente] : [];
      const energiaBaja = [...registrosDia, ...registrosDiaSiguiente].some(r =>
        r.energia !== null && r.energia <= 2
      );
      if (energiaBaja) correlaciones++;
    }
  });
  if (correlaciones >= 2) {
    await crearInsight(usuarioId, 'sueno_energia', 'sueno_bajo_energia_baja_7d', {
      dias_analizados: 7, correlaciones_detectadas: correlaciones, umbral_sueno: 2, umbral_energia: 2
    });
  }
}

async function armarContextoReciente(usuarioId) {
  const hace7dias = new Date();
  hace7dias.setDate(hace7dias.getDate() - 7);
  const { data: registros } = await supabase
    .from('registros')
    .select('*')
    .eq('usuario_id', usuarioId)
    .gte('created_at', hace7dias.toISOString())
    .order('created_at', { ascending: true });

  if (!registros || registros.length === 0) return null;

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
      const dia = new Date(r.created_at).toISOString().split('T')[0];
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
    const intensidades = sintomas.filter(r => r.sintoma_intensidad !== null).map(r => r.sintoma_intensidad);
    const maxIntensidad = intensidades.length > 0 ? Math.max(...intensidades) : null;
    const tiposUnicos = [...new Set(sintomas.filter(r => r.sintoma_tipo).map(r => r.sintoma_tipo))];
    contexto += `Síntomas:\n- registros: ${sintomas.length}\n`;
    if (tiposUnicos.length > 0) contexto += `- tipos: ${tiposUnicos.join(', ')}\n`;
    if (maxIntensidad) contexto += `- intensidad máxima: ${maxIntensidad}/5\n`;
  }

  return contexto;
}

function getFechaArgentina() {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires'
  });
}

function getInicioHoyArgentina() {
  const hoyArg = getFechaArgentina();
  return new Date(hoyArg + 'T03:00:00.000Z');
}

async function armarRegistrosHoy(usuarioId) {
  const inicioHoy = getInicioHoyArgentina();
  const { data: registros } = await supabase
    .from('registros')
    .select('tipo_registro, comida_momento, created_at')
    .eq('usuario_id', usuarioId)
    .gte('created_at', inicioHoy.toISOString())
    .order('created_at', { ascending: true });

  if (!registros || registros.length === 0) return 'Hoy no hay registros todavía.';

  const tipos = registros.map(r => {
    if (r.tipo_registro === 'comida') return r.comida_momento || 'comida';
    return r.tipo_registro;
  });

  return `Registrado hoy (${getFechaArgentina()}): ${tipos.join(', ')}.`;
}

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

  const mensajesConImagen = [
    ...mensajesPrevios.slice(0, -1),
    { role: 'user', content: contenidoImagen }
  ];

  return await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 500,
    system: systemFinal,
    messages: mensajesConImagen,
  });
}

// Genera el resumen semanal con datos reales
async function generarResumenSemanal(usuarioId) {
  const hace7dias = new Date();
  hace7dias.setDate(hace7dias.getDate() - 7);

  const { data: registros } = await supabase
    .from('registros')
    .select('*')
    .eq('usuario_id', usuarioId)
    .gte('created_at', hace7dias.toISOString())
    .order('created_at', { ascending: true });

  const { data: user } = await supabase
    .from('usuarios')
    .select('nombre, contexto_base')
    .eq('id', usuarioId)
    .single();

  const { data: estado } = await supabase
    .from('estado_usuario')
    .select('madurez_sabi, dias_con_datos')
    .eq('usuario_id', usuarioId)
    .single();

  // Verificar datos suficientes — mínimo 3 días con datos en los últimos 7
  const diasConDatosEstaSemana = new Set(
    (registros || []).map(r => new Date(r.created_at).toISOString().split('T')[0])
  ).size;

  if (diasConDatosEstaSemana < 3) {
    return 'Esta semana todavía tengo pocos datos para hacer un resumen útil. Lo más honesto es seguir acumulando registros unos días más.';
  }

  // Armar datos estructurados para pasarle al modelo
  const suenos = (registros || []).filter(r => r.tipo_registro === 'sueno');
  const entrenos = (registros || []).filter(r => r.tipo_registro === 'entrenamiento');
  const comidas = (registros || []).filter(r => r.tipo_registro === 'comida');
  const estados = (registros || []).filter(r => r.tipo_registro === 'estado');
  const sintomas = (registros || []).filter(r => r.tipo_registro === 'sintoma');

  let datosResumen = `DATOS DE LA SEMANA (últimos 7 días):\n\n`;

  // Sueño
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
  }

  // Entrenamiento
  if (entrenos.length > 0) {
    const fuerza = entrenos.filter(r => r.entreno_tipo === 'fuerza').length;
    const cardio = entrenos.filter(r => r.entreno_tipo === 'cardio').length;
    const ayunas = entrenos.filter(r => r.entreno_ayunas === true).length;
    datosResumen += `ENTRENAMIENTO: ${entrenos.length} sesiones.`;
    if (fuerza) datosResumen += ` Fuerza: ${fuerza}.`;
    if (cardio) datosResumen += ` Cardio: ${cardio}.`;
    if (ayunas) datosResumen += ` En ayunas: ${ayunas}.`;
    datosResumen += '\n\n';
  }

  // Alimentación
  if (comidas.length > 0) {
    const almuerzos = comidas.filter(r => r.comida_momento === 'almuerzo').length;
    const meriendas = comidas.filter(r => r.comida_momento === 'merienda').length;
    const cenas = comidas.filter(r => r.comida_momento === 'cena').length;
    datosResumen += `ALIMENTACIÓN: ${comidas.length} registros. Almuerzos: ${almuerzos}, meriendas: ${meriendas}, cenas: ${cenas}.\n\n`;
  }

  // Energía y estado
  if (estados.length > 0) {
    const energias = estados.filter(r => r.energia !== null).map(r => r.energia);
    const promEnergia = energias.length > 0 ? (energias.reduce((a, b) => a + b, 0) / energias.length).toFixed(1) : null;
    datosResumen += `ENERGÍA: ${estados.length} registros.`;
    if (promEnergia) datosResumen += ` Promedio ${promEnergia}/5.`;
    datosResumen += '\n\n';
  }

  // Síntomas
  if (sintomas.length > 0) {
    const tiposUnicos = [...new Set(sintomas.filter(r => r.sintoma_tipo).map(r => r.sintoma_tipo))];
    datosResumen += `SÍNTOMAS: ${sintomas.length} registro/s. Tipos: ${tiposUnicos.join(', ')}.\n\n`;
  }

  datosResumen += `DÍAS CON DATOS ESTA SEMANA: ${diasConDatosEstaSemana}\n`;
  datosResumen += `MADUREZ DEL SISTEMA: ${estado?.madurez_sabi || 'escucha'}\n`;

  const promptResumen = `Sos Sabi. Generá el resumen semanal de salud para ${user?.nombre || 'el usuario'}.

PERFIL BASE:
${user?.contexto_base || 'Sin perfil disponible'}

${datosResumen}

INSTRUCCIONES PARA EL RESUMEN:
- Máximo 250 palabras en total
- Sin listas, sin bullets, sin markdown, solo texto plano
- Sin emojis
- Estructura exacta (en prosa continua):
  1. Una observación sobre sueño — dato + interpretación en su contexto
  2. Una observación sobre movimiento/recuperación
  3. Una observación sobre nutrición o energía
  4. El patrón más interesante de la semana — la conexión más relevante entre pilares
  5. Una sola sugerencia concreta y pequeña para la semana siguiente
- La sugerencia debe ser específica y accionable — algo que pueda hacer mañana
- Nunca terminar con "seguí así" genérico
- Si hay pocos datos en algún pilar, decirlo honestamente en lugar de inventar
- Tono cálido, directo, sin moralizar`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 600,
    messages: [{ role: 'user', content: promptResumen }]
  });

  return response.content[0].text;
}

app.get('/', (req, res) => {
  res.json({ status: 'Sabi está vivo', version: '3.0.0' });
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
    const esAperturaDia = mensaje && mensaje.startsWith('APERTURA_DIA:');
    const esReapertura = mensaje === 'reapertura_del_dia';
    const esMensajeSistema = esAperturaDia || esReapertura;
    const tieneImagenes = imagenes && imagenes.length > 0;

    let registrosExtraidos = [];
    let cantidadGuardada = 0;

    if (!enOnboarding && !esMensajeSistema) {
      registrosExtraidos = await extraerRegistros(mensaje, imagenes);
      cantidadGuardada = await guardarRegistros(user.id, mensaje, registrosExtraidos);
    }

    if (cantidadGuardada > 0) {
      try {
        await evaluarSenales(user.id);
        await actualizarMadurez(user.id); // Actualizar madurez después de cada registro
      } catch (error) {
        console.error('Error post-registro:', error.message);
      }
    }

    // Recargar estado actualizado después de posible cambio de madurez
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
      .select('tipo_insight, regla_origen, evidencia_json, confianza')
      .eq('usuario_id', user.id)
      .eq('estado', 'pendiente')
      .order('created_at', { ascending: false })
      .limit(3);

    const contextoReciente = !enOnboarding ? await armarContextoReciente(user.id) : null;
    const registrosHoy = !enOnboarding ? await armarRegistrosHoy(user.id) : null;

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
        systemFinal += '\nEste usuario es un adulto mayor. Tono más simple, más cálido, más pausado.';
      }
    }

    if (!enOnboarding && estadoFinal.madurez_sabi) {
      const madurezTexto = {
        'escucha': 'Estás en etapa de escucha — primeros días. Acusá recibo, respondé consultas directas, no des insights proactivos todavía.',
        'tendencia_temprana': 'Tenés una semana de datos. Podés señalar tendencias tentativas con honestidad sobre la certeza. Podés hacer observaciones basadas en patrones que empezás a ver.',
        'patron_confirmado': 'Tenés patrones confirmados. Podés dar insights con confianza y hacer sugerencias concretas basadas en correlaciones reales.',
        'profundo': 'Conocés bien el ritmo de esta persona. Podés detectar desvíos del patrón habitual y hacer conexiones sutiles entre pilares.'
      };
      systemFinal += `\n\nETAPA ACTUAL: ${madurezTexto[estadoFinal.madurez_sabi]}`;
    }

    if (!enOnboarding && contextoReciente) {
      systemFinal += `\n\n${contextoReciente}`;
    }

    if (!enOnboarding && registrosHoy) {
      systemFinal += `\n\nREGISTROS DE HOY: ${registrosHoy}`;
    }

    if (!enOnboarding && registrosExtraidos.length > 0) {
      systemFinal += `\n\nDATOS REGISTRADOS EN ESTE MENSAJE (${registrosExtraidos.length} registro/s):\n${JSON.stringify(registrosExtraidos, null, 2)}`;
    }

    if (!enOnboarding && insightsPendientes && insightsPendientes.length > 0) {
      systemFinal += '\n\nSEÑALES DETECTADAS (mencioná solo si es relevante y natural):\n';
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

    if (!enOnboarding) {
      systemFinal += '\n\nREGLA DE USO DEL CONTEXTO: El CONTEXTO RECIENTE y los DATOS REGISTRADOS EN ESTE MENSAJE tienen prioridad sobre el PERFIL DEL USUARIO para el estado actual. REGISTROS DE HOY indica qué ya fue registrado hoy — nunca preguntes por algo que ya está ahí. Si el mensaje tiene múltiples registros, acusá recibo brevemente en una sola respuesta. Si registró la cena o son más de las 21:00 y ya registró las comidas principales, cerrá el día sin abrir nuevas preguntas. Después de acusar recibo podés sugerir el próximo momento lógico del día como pregunta breve. Nunca más de una sugerencia. Si es adulto mayor, no anticipes actividad física.';
    }

    const mensajesPrevios = (historial || [])
      .reverse()
      .map(h => ({ role: h.rol, content: h.mensaje }));

    mensajesPrevios.push({ role: 'user', content: mensaje || '[imágenes]' });

    if (!esMensajeSistema) {
      const mensajeGuardado = tieneImagenes
        ? '[imagen' + (imagenes.length > 1 ? 'es' : '') + ']' + (mensaje ? ': ' + mensaje : '')
        : mensaje;
      await supabase.from('conversaciones').insert([{
        usuario_id: user.id, rol: 'user', mensaje: mensajeGuardado
      }]);
    }

    let response;
    if (tieneImagenes) {
      response = await generarRespuestaConImagenes(systemFinal, mensajesPrevios, mensaje, imagenes);
    } else {
      response = await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 500,
        system: systemFinal,
        messages: mensajesPrevios,
      });
    }

    const respuesta = response.content[0].text;

    await supabase.from('conversaciones').insert([{
      usuario_id: user.id, rol: 'assistant', mensaje: respuesta
    }]);

    await supabase
      .from('estado_usuario')
      .update({ ultimo_mensaje_at: new Date().toISOString() })
      .eq('usuario_id', user.id);

    res.json({
      respuesta,
      usuario: user.nombre,
      onboarding: enOnboarding,
      modo: estadoFinal.modo_usuario,
      madurez: estadoFinal.madurez_sabi,
      registros_guardados: cantidadGuardada,
      insights_pendientes: insightsPendientes ? insightsPendientes.length : 0
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}

app.get('/chat/:usuario/:mensaje', async (req, res) => {
  const { usuario, mensaje } = req.params;
  await procesarChat(usuario, mensaje, res, null);
});

app.post('/chat', async (req, res) => {
  const { usuario, mensaje, imagenes } = req.body;
  if (!usuario || (!mensaje && (!imagenes || imagenes.length === 0))) {
    return res.status(400).json({ error: 'Faltan usuario y mensaje o imágenes' });
  }
  const imagenesValidadas = imagenes ? imagenes.slice(0, 5) : null;
  await procesarChat(usuario, mensaje || '', res, imagenesValidadas);
});

// Endpoint de resumen semanal
app.post('/resumen', async (req, res) => {
  const { usuario } = req.body;
  if (!usuario) return res.status(400).json({ error: 'Falta usuario' });

  try {
    const { data: user } = await supabase
      .from('usuarios')
      .select('*')
      .eq('telefono', usuario)
      .single();

    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const resumen = await generarResumenSemanal(user.id);

    // Guardar en conversaciones
    await supabase.from('conversaciones').insert([{
      usuario_id: user.id,
      rol: 'assistant',
      mensaje: resumen
    }]);

    // Actualizar fecha del último resumen
    await supabase
      .from('estado_usuario')
      .update({ ultimo_resumen_semanal_at: new Date().toISOString() })
      .eq('usuario_id', user.id);

    res.json({ resumen, usuario: user.nombre });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
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
