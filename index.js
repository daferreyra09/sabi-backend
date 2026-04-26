const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const app = express();
app.use(express.json());

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

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

// Ruta de estado
app.get('/', (req, res) => {
  res.json({ status: 'Sabi está vivo 🌱', version: '1.0.0' });
});

// Ruta de prueba desde el navegador
app.get('/chat/:mensaje', async (req, res) => {
  const mensaje = req.params.mensaje;
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: SABI_SYSTEM,
      messages: [{ role: 'user', content: mensaje }],
    });
    res.json({ respuesta: response.content[0].text });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Ruta principal POST
app.post('/mensaje', async (req, res) => {
  const { mensaje, contexto } = req.body;
  if (!mensaje) {
    return res.status(400).json({ error: 'Falta el mensaje' });
  }
  try {
    const messages = [];
    if (contexto && Array.isArray(contexto)) {
      messages.push(...contexto);
    }
    messages.push({
      role: 'user',
      content: mensaje
    });
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: SABI_SYSTEM,
      messages: messages,
    });
    const respuestaSabi = response.content[0].text;
    res.json({
      respuesta: respuestaSabi,
      mensaje_enviado: mensaje
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Algo salió mal', detalle: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sabi escuchando en puerto ${PORT}`);
});
