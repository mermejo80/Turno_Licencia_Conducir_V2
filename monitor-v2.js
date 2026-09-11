const { chromium } = require("playwright-core");

const URL_TURNOS =
  "https://turnos.argentina.gob.ar/turnos/seleccionTurno/3219/pais/37/prov/67/loc/2875/pda/3616";
const API_GITHUB = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}`;
const VARIABLE_ESTADO = "MONITOR_STATE_V2";
const tokenTelegram = process.env.TELEGRAM_BOT_TOKEN;
const chatAutorizado = process.env.TELEGRAM_CHAT_ID;
const tokenGitHub = process.env.GH_TOKEN;

function ahora() {
  return new Date().toISOString();
}

function horaItalia(fecha) {
  if (!fecha) return "todavía no disponible";
  return new Intl.DateTimeFormat("es-AR", {
    timeZone: "Europe/Rome",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(fecha));
}

function estadoInicial() {
  return {
    pausado: false,
    ultimaConsulta: null,
    ultimoEstado: "sin registros",
    ultimoDetalle: "El monitor todavía no realizó una consulta.",
    historial: [],
    firmaDisponibilidad: null,
    firmaProblema: null,
    erroresConsecutivos: 0,
  };
}

async function github(ruta, opciones = {}) {
  const respuesta = await fetch(`${API_GITHUB}${ruta}`, {
    ...opciones,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${tokenGitHub}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(opciones.headers || {}),
    },
  });
  return respuesta;
}

async function cargarEstado() {
  const respuesta = await github(`/actions/variables/${VARIABLE_ESTADO}`);
  if (respuesta.status === 404) return estadoInicial();
  if (!respuesta.ok) throw new Error(`No se pudo leer el estado de GitHub (${respuesta.status}).`);
  const datos = await respuesta.json();
  try {
    return { ...estadoInicial(), ...JSON.parse(datos.value) };
  } catch (_) {
    return estadoInicial();
  }
}

async function guardarEstado(estado) {
  estado.historial = (estado.historial || []).slice(-30);
  const value = JSON.stringify(estado);
  let respuesta = await github(`/actions/variables/${VARIABLE_ESTADO}`, {
    method: "PATCH",
    body: JSON.stringify({ name: VARIABLE_ESTADO, value }),
  });
  if (respuesta.status === 404) {
    respuesta = await github("/actions/variables", {
      method: "POST",
      body: JSON.stringify({ name: VARIABLE_ESTADO, value }),
    });
  }
  if (!respuesta.ok) {
    const texto = await respuesta.text();
    throw new Error(`No se pudo guardar el estado (${respuesta.status}): ${texto}`);
  }
}

async function enviarTelegram(texto) {
  const respuesta = await fetch(`https://api.telegram.org/bot${tokenTelegram}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatAutorizado,
      text: texto,
      disable_web_page_preview: true,
    }),
  });
  const datos = await respuesta.json();
  if (!respuesta.ok || !datos.ok) {
    throw new Error(datos.description || `Telegram respondió ${respuesta.status}.`);
  }
}

function resumenEstado(estado) {
  const modo = estado.pausado ? "⏸ PAUSADO" : "✅ ACTIVO";
  return (
    `${modo}\n\n` +
    `Última consulta web: ${horaItalia(estado.ultimaConsulta)}\n` +
    `Resultado: ${estado.ultimoEstado}\n` +
    `Detalle: ${estado.ultimoDetalle}`
  );
}

function textoHistorial(estado) {
  const registros = (estado.historial || []).slice(-10).reverse();
  if (!registros.length) return "Todavía no hay consultas registradas.";
  return (
    "📋 ÚLTIMAS CONSULTAS\n\n" +
    registros
      .map(
        (r, i) =>
          `${i + 1}. ${horaItalia(r.fecha)} — ${r.estado}\n   ${r.detalle}`
      )
      .join("\n")
  );
}

async function procesarComandos(estado) {
  const respuesta = await fetch(`https://api.telegram.org/bot${tokenTelegram}/getUpdates?timeout=0`);
  const datos = await respuesta.json();
  if (!respuesta.ok || !datos.ok) {
    throw new Error(datos.description || "No se pudieron leer los mensajes de Telegram.");
  }

  let maxUpdate = null;
  for (const update of datos.result || []) {
    maxUpdate = Math.max(maxUpdate ?? 0, update.update_id);
    const mensaje = update.message;
    if (!mensaje || String(mensaje.chat.id) !== String(chatAutorizado)) continue;
    const comando = (mensaje.text || "").trim().toLowerCase().split("@")[0];

    if (comando === "/pausar") {
      estado.pausado = true;
      await enviarTelegram(
        "⏸ Monitor pausado. Seguiré atendiendo comandos, pero no consultaré la web hasta recibir /reanudar."
      );
    } else if (comando === "/reanudar") {
      estado.pausado = false;
      await enviarTelegram("▶️ Monitor reanudado. Haré una consulta web en esta ejecución.");
    } else if (comando === "/estado" || comando === "/ultima") {
      await enviarTelegram(resumenEstado(estado));
    } else if (comando === "/historial") {
      await enviarTelegram(textoHistorial(estado));
    } else {
      await enviarTelegram(
        "Comandos disponibles:\n" +
          "/estado — estado y última consulta\n" +
          "/ultima — último resultado\n" +
          "/historial — últimas 10 consultas\n" +
          "/pausar — detener consultas web\n" +
          "/reanudar — volver a consultar"
      );
    }
  }

  if (maxUpdate !== null) {
    await fetch(
      `https://api.telegram.org/bot${tokenTelegram}/getUpdates?offset=${maxUpdate + 1}&timeout=0`
    );
  }
}

async function consultarWeb() {
  let browser;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const contexto = await browser.newContext({ locale: "es-AR" });
    const pagina = await contexto.newPage();
    const respuesta = await pagina.goto(URL_TURNOS, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await pagina.waitForTimeout(12000);
    const codigo = respuesta ? respuesta.status() : 0;
    const cuerpo = await pagina.locator("body").innerText({ timeout: 15000 });
    const texto = cuerpo.toLowerCase();

    if (codigo >= 400) throw new Error(`La página respondió con código ${codigo}.`);
    if (!texto.includes("elegí la sede") || !texto.includes("paso 1 de 2")) {
      throw new Error("La página no terminó de cargar su sección de turnos.");
    }

    const sedeHabilitada =
      (await pagina.locator('input[id^="puntoAtencion_"]:not(:disabled)').count()) > 0;
    const fechas = await pagina
      .locator('td.day[data-day]:not(.disabled):not(.old):not(.new)')
      .evaluateAll((celdas) =>
        celdas
          .filter((celda) => !celda.classList.contains("today"))
          .map((celda) => celda.getAttribute("data-day"))
          .filter(Boolean)
      );
    const horarios = await pagina
      .locator('input[type="radio"]:not(:disabled):not([id^="puntoAtencion_"])')
      .evaluateAll((controles) =>
        controles.map((control) => {
          const etiqueta = control.id
            ? document.querySelector(`label[for="${control.id}"]`)
            : null;
          const textoCercano =
            etiqueta?.innerText ||
            control.closest("label")?.innerText ||
            control.parentElement?.innerText;
          return (textoCercano || control.value || "horario").trim();
        })
      );
    const sinDisponibilidad = texto.includes("sin disponibilidad");

    // La referencia real confirmó que el radio de sede puede seguir deshabilitado
    // aunque haya turnos. Por eso las fechas data-day, los horarios habilitados y
    // la desaparición de la leyenda tienen prioridad.
    if (sinDisponibilidad) {
      return { estado: "SIN DISPONIBILIDAD", detalle: "La sede continúa sin turnos.", firma: null };
    }
    if (sedeHabilitada || fechas.length || horarios.length) {
      const elementos = [...new Set([...fechas, ...horarios])];
      return {
        estado: "DISPONIBLE",
        detalle: elementos.length
          ? `Opciones detectadas: ${elementos.join(", ")}`
          : "La sede está habilitada para seleccionar.",
        firma: JSON.stringify(elementos.length ? elementos : ["sede-habilitada"]),
      };
    }
    // La página específica de este trámite elimina esta leyenda cuando habilita
    // turnos. Solo aplicamos esta regla después de validar que la sección de
    // turnos terminó de cargar correctamente.
    return {
      estado: "DISPONIBLE",
      detalle: "La página cargó correctamente y desapareció la leyenda 'Sin disponibilidad'.",
      firma: "leyenda-sin-disponibilidad-ausente",
    };
  } finally {
    if (browser) await browser.close();
  }
}

async function ejecutar() {
  if (!tokenTelegram || !chatAutorizado || !tokenGitHub || !process.env.GITHUB_REPOSITORY) {
    throw new Error("Falta la configuración de Telegram o GitHub.");
  }

  const estado = await cargarEstado();
  await procesarComandos(estado);

  if (process.env.ENVIAR_PRUEBA === "true") {
    await enviarTelegram(
      "✅ BOT V2 CONECTADO\n\nTelegram, historial y control de pausa están configurados."
    );
  }

  if (estado.pausado) {
    await guardarEstado(estado);
    console.log("Monitor pausado: no se consultó la web.");
    return;
  }

  let resultado;
  try {
    resultado = await consultarWeb();
    estado.erroresConsecutivos = 0;
  } catch (error) {
    estado.erroresConsecutivos = (estado.erroresConsecutivos || 0) + 1;
    resultado = {
      estado: "ERROR",
      detalle: error.message,
      firma: `error:${error.message}`,
    };
  }

  estado.ultimaConsulta = ahora();
  estado.ultimoEstado = resultado.estado;
  estado.ultimoDetalle = resultado.detalle;
  estado.historial.push({
    fecha: estado.ultimaConsulta,
    estado: resultado.estado,
    detalle: resultado.detalle,
  });

  if (resultado.estado === "DISPONIBLE") {
    if (estado.firmaDisponibilidad !== resultado.firma) {
      await enviarTelegram(
        `🚨 ¡TURNO DISPONIBLE!\n\n${resultado.detalle}\n\nReserva inmediatamente:\n${URL_TURNOS}\n\nSi no te interesa esta disponibilidad, envía /pausar.`
      );
    }
    estado.firmaDisponibilidad = resultado.firma;
    estado.firmaProblema = null;
  } else if (resultado.estado === "SIN DISPONIBILIDAD") {
    estado.firmaDisponibilidad = null;
    estado.firmaProblema = null;
  } else if (resultado.estado === "ERROR" && estado.erroresConsecutivos >= 3) {
    if (estado.firmaProblema !== resultado.firma) {
      await enviarTelegram(
        `⚠️ ERROR DEL MONITOR V2\n\nFallaron tres consultas consecutivas.\n${resultado.detalle}`
      );
    }
    estado.firmaProblema = resultado.firma;
  }

  await guardarEstado(estado);
  console.log(`${resultado.estado}: ${resultado.detalle}`);
}

ejecutar().catch((error) => {
  console.error(error);
  process.exit(1);
});
