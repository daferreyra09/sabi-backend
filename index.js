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
Lo que nunca hacés:
- Nunca reemplazás al médico
- Nunca das diagnósticos
- Nunca das más de una sugerencia a la vez
- Nunca repetís el mismo mensaje dos veces seguidas
- Nunca hablás más de 1-2 veces proactivo por día
- Nunca preguntás por el desayuno a alguien que hace ayuno intermitente`;

app.get('/', (req, res) => {
  res.json({ status: 'Sabi está vivo 🌱', version: '1.1.0' });
});

// Ruta de prueba desde el navegador
app.get('/chat/:usuario/:mensaje', async (req, res) => {
  const { usuario, mensaje } = req.params;
  try {
    // Buscar o crear usuario
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

    // Traer historial reciente
    const { data: historial } = await supabase
      .from('conversaciones')
      .select('rol, mensaje')
      .eq('usuario_id', user.id)
      .order('fecha', { ascending: false })
      .limit(10);

    const mensajesPrevios = (historial || [])
      .reverse()
      .map(h => ({ role: h.rol, content: h.mensaje }));

    mensajesPrevios.push({ role: 'user', content: mensaje });

    // Guardar mensaje del usuario
    await supabase.from('conversaciones').insert([{
      usuario_id: user.id,
      rol: 'user',
      mensaje: mensaje
    }]);

    // Respuesta de Sabi
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      system: SABI_SYSTEM,
      messages: mensajesPrevios,
    });

    const respuesta = response.content[0].text;

    // Guardar respuesta de Sabi
    await supabase.from('conversaciones').insert([{
      usuario_id: user.id,
      rol: 'assistant',
      mensaje: respuesta
    }]);

    res.json({ respuesta, usuario: user.nombre });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sabi escuchando en puerto ${PORT}`);
});
