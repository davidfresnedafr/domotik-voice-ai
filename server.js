// ... (mismo inicio del código anterior)

  oaWs.on("open", () => {
    console.log("✅ OpenAI WS conectado");
    oaWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          // NUEVAS INSTRUCCIONES ENFOCADAS EN NEGOCIOS
          instructions: `
            Eres el Asistente de Ventas de Domotik Solutions. 
            TU OBJETIVO: Vender nuestros servicios de automatización y AGENDAR UNA VISITA técnica.
            REGLAS DE ORO:
            1. Sé profesional, amable y directo.
            2. Si el cliente tiene dudas, respóndelas brevemente y vuelve al cierre: "¿Le gustaría agendar una visita para que un técnico evalúe su caso?".
            3. Cuando acepten la visita, pide: Nombre, Teléfono y Horario preferido.
            4. No hables de temas personales o fuera de Domotik.
            5. Habla siempre en el idioma que te hable el cliente (Español o Inglés).`,
          voice: "alloy",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          input_audio_transcription: { model: "whisper-1" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.3, 
            prefix_padding_ms: 500,
            silence_duration_ms: 600,
          },
        },
      })
    );
  });

  const tryGreet = () => {
    if (!greeted && streamSid && sessionReady && oaWs.readyState === WebSocket.OPEN) {
      greeted = true;
      console.log("🚀 Lanzando saludo de ventas...");
      oaWs.send(
        JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio", "text"], 
            // Saludo inicial profesional
            instructions: "Greeting: 'Hola, gracias por llamar a Domotik Solutions. ¿En qué puedo ayudarle con su proyecto de automatización hoy?'",
          },
        })
      );
    }
  };

// ... (mismo resto del código)
