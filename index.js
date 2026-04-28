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
- Sin exceso de emojis — solo cuando agregan algo, nunca como decoración
Lo que nunca hacés:
- Nunca reemplazás al médico
- Nunca das diagnósticos
- Nunca das más de una sugerencia a la vez
- Nunca repetís el mismo mensaje dos veces seguidas
- Nunca hablás más de 1-2 veces proactivo por día
- Nunca preguntás por el desayuno a alguien que hace ayuno intermitente`;

const SABI_ONBOARDING = `Sos Sabi. Alguien te escribió por primera vez. 
Tu único objetivo ahora es conocerlo de forma natural y cálida, sin que parezca un formulario.
Presentate brevemente — una sola oración. No expliques todo lo que hacés.
Después preguntá solo su nombre. Nada más por ahora.
Cuando te diga el nombre, preguntá su edad.
Cuando te diga la edad, preguntá una sola cosa: qué es lo que más quiere mejorar o entender de cómo se siente.
Después de esas tres respuestas, decile que ya tenés lo suficiente para empezar y que puede contarte lo que quiera cuando quiera.
Tono: cálido, cercano, sin prisa. Como alguien que recién conocés pero que ya genera confianza.`;

app.get('/', (req, res) => {
  res.json({ status: 'Sabi está vivo 🌱', version: '1.6.0' });
});

// Función para extraer datos del onboarding
function extraerDatosOnboarding(historial) {
  const texto = historial.map(h => h.mensaje).join(' ').toLowerCase();
  const datos = {};
  
  // Intentar extraer nombre
  const mensajesUsuario = historial.filter(h => h.rol === 'user');
  if (mensajesUsuario.length >= 1) {
    const primerMensaje = mensajesUsuario[0].mensaje;
    if (primerMensaje.length < 30 && !primerMensaje.includes('?')) {
      datos.posible_nombre = primerMensaje.trim();
    }
  }
  
  return datos;
}

app.get('/chat/:usuario/:mensaje', async (req, res) => {
  const { usuario, mensaje } = req.params;
  try {
    // Buscar usuario
    let { data: user } = await supabase
      .from('usuarios')
      .select('*')
      .eq('telefono', usuario)
      .single();

    const esUsuarioNuevo = !user;

    if (!user) {
      const { data: newUser } = await supabase
        .from('usuarios')
        .insert([{ telefono: usuario, nombre: usuario }])
        .select()
        .single();
      user = newUser;
    }

    // Traer historial
    const { data: historial } = await supabase
      .from('conversaciones')
      .select('rol, mensaje, fecha')
      .eq('usuario_id', user.id)
      .order('fecha', { ascending: false })
      .limit(20);

    const cantidadMensajes = historial ? historial.length : 0;
    const enOnboarding = cantidadMensajes < 8;

    // Traer eventos proximos
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

    // Construir system prompt
    let systemFinal = enOnboarding ? SABI_ONBOARDING : SABI_SYSTEM;

    if (!enOnboarding && user.contexto_base) {
      systemFinal += `\n\nPERFIL DEL USUARIO:\n${user.contexto_base}`;
    }

    if (!enOnboarding && eventosProximos && eventosProximos.length > 0) {
      systemFinal += '\n\nEVENTOS PROXIMOS:\n';
      eventosProximos.forEach(e => {
        const fecha = new Date(e.fecha_evento).toLocaleDateString('es-AR');
        const diasRestantes = Math.ceil((new Date(e.fecha_evento) - hoy) / (1000 * 60 * 60 * 24));
        systemFinal += `- ${e.titulo}: ${fecha} (en ${diasRestantes} dias) — ${e.descripcion}\n`;
      });
      systemFinal += 'Menciona estos eventos solo cuando sea relevante.';
    }

    const mensajesPrevios = (historial || [])
      .reverse()
      .map(h => ({ role: h.rol, content: h.mensaje }));

    mensajesPrevios.push({ role: 'user', content: mensaje });

    // Guardar mensaje usuario
    await supabase.from('conversaciones').insert([{
      usuario_id: user.id,
      rol: 'user',
      mensaje: mensaje
    }]);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      system: systemFinal,
      messages: mensajesPrevios,
    });

    const respuesta = response.content[0].text;

    // Guardar respuesta
    await supabase.from('conversaciones').insert([{
      usuario_id: user.id,
      rol: 'assistant',
      mensaje: respuesta
    }]);

    res.json({
      respuesta,
      usuario: user.nombre,
      onboarding: enOnboarding,
      mensajes_totales: cantidadMensajes
    });

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
        { id: 1, pregunta: '¿Cómo estuvo tu energía hoy?', opciones: ['Alta', 'Normal', 'Baja', 'Sin nada'], pilar: 'foco_energia' },
        { id: 2, pregunta: '¿Cómo te sentiste por dentro?', opciones: ['Bien 😊', 'Regular', 'Pesado', 'Ansioso'], pilar: 'estres_recuperacion' },
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
