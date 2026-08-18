# Dub Siren MK-1

Sintetizador de sirena dub (Web Audio API). Se puede instalar en el iPhone de dos formas:

1. **Como app web instalable (PWA)** — sin Xcode, sin Mac, sin TestFlight. Es la forma recomendada si solo quieres tenerla en tu iPhone ya. Ver [Instalar en el iPhone sin Xcode](#instalar-en-el-iphone-sin-xcode-pwa) más abajo.
2. **Como app nativa con Capacitor + Xcode** — necesita un Mac. Ver [Compilar como app nativa de iOS](#compilar-como-app-nativa-de-ios-necesita-un-mac) más abajo.

## Estructura

```
www/                     código web (la app en sí: HTML/CSS/JS, sin dependencias)
  index.html
  style.css
  app.js
  manifest.json          manifest de la PWA (icono, nombre, modo standalone)
  sw.js                  service worker: cachea la app para que funcione offline
  icons/                 iconos de la PWA
.github/workflows/pages.yml  publica www/ en GitHub Pages en cada push a main
capacitor.config.json    configuración de Capacitor (appId, appName, webDir)
ios/                     proyecto nativo de Xcode, generado por Capacitor
```

`www/` es una app web normal y autocontenida: se puede abrir `www/index.html` directamente en un navegador para probar el sonido sin instalar nada.

## Instalar en el iPhone sin Xcode (PWA)

Esto se prepara entero desde Windows (o cualquier SO), no hace falta Mac.

**Publicar la app (una vez, desde GitHub, en el navegador):**

1. En `github.com/jamm87/portable-siren` → **Settings** → **Pages**.
2. En "Build and deployment" → "Source", elige **GitHub Actions** (no "Deploy from a branch").
3. Con eso ya está: el workflow `.github/workflows/pages.yml` publica automáticamente el contenido de `www/` en cada push a `main`. Puedes ver el progreso en la pestaña **Actions** del repo; cuando termine, la URL aparece en Settings → Pages, con esta forma: `https://jamm87.github.io/portable-siren/`.

**Instalar en el iPhone:**

1. Abre esa URL en **Safari** en el iPhone (tiene que ser Safari, no Chrome ni otro navegador — solo Safari puede instalar apps web en iOS).
2. Toca el icono de **Compartir** (el cuadrado con la flecha hacia arriba).
3. Desplázate y toca **"Añadir a pantalla de inicio"**.
4. Confirma el nombre ("Dub Siren") y toca **Añadir**.

Te queda un icono en la pantalla de inicio, a pantalla completa (sin la barra de Safari), con el mismo icono dorado que la app nativa, y funciona sin conexión gracias al service worker. Cada vez que actualices `www/` y hagas push a `main`, el despliegue se repite solo; para ver los cambios en el iPhone basta con recargar la página una vez con conexión (el service worker se actualiza solo) o borrar y volver a añadir el icono si hace falta forzarlo.

## Compilar como app nativa de iOS (necesita un Mac)

## Requisitos

- Node.js 18+ y npm (para Capacitor).
- **macOS con Xcode** para compilar/firmar/ejecutar la app de iOS — este paso no se puede hacer desde Linux/este entorno, solo se puede generar y sincronizar el proyecto.
- Un iPhone (probado apuntando a un iPhone 12 mini) con cable Lightning/USB-C, o la misma red Wi‑Fi que el Mac.
- Una cuenta de Apple normal y corriente (gratis) para firmar la app e instalarla en tu propio dispositivo — **no** hace falta pagar el Apple Developer Program (99 $/año) para esto.

## Poner en marcha (en un Mac)

```bash
git clone <este repo>
cd portable-siren
npm install
npx cap sync ios
open ios/App/App.xcodeproj
```

Capacitor 8 usa Swift Package Manager en vez de CocoaPods, así que no hace falta `pod install`: basta con abrir `App.xcodeproj` (no hay `.xcworkspace`) y Xcode resuelve las dependencias solo.

## Ejecutar en tu iPhone 12 mini

1. Conecta el iPhone al Mac por cable (o actívalo por red: Xcode → Window → Devices and Simulators → tu iPhone → "Connect via network").
2. En Xcode, selecciona el target **App** y en la parte superior elige tu iPhone como destino (en vez del simulador).
3. Pestaña **Signing & Capabilities** del target App:
   - Marca "Automatically manage signing".
   - En "Team" elige tu Apple ID personal (si no aparece, añádelo en Xcode → Settings → Accounts). Xcode creará un "Personal Team" gratuito.
4. Pulsa ▶️ Run. Xcode compila, instala y lanza la app en el iPhone.
5. **La primera vez el iPhone bloqueará la app** por no ser de un desarrollador de confianza: ve a Ajustes → General → VPN y gestión de dispositivos → toca tu Apple ID de desarrollador → Confiar. Vuelve a lanzarla desde la pantalla de inicio o desde Xcode.

Nota: los perfiles de firma gratuitos caducan a los 7 días; pasado ese tiempo hay que volver a compilar/instalar desde Xcode (no supone perder nada, es solo una limitación de la firma gratuita frente a la de pago).

## Tras cambiar algo en `www/`

Cada vez que edites `www/index.html`, `style.css` o `app.js`, vuelve a sincronizar antes de compilar en Xcode:

```bash
npx cap sync ios
```

## Publicar en la App Store (más adelante, no ahora)

Esto no está configurado todavía. Cuando llegue el momento hará falta:
- Una cuenta del Apple Developer Program (de pago).
- Icono/splash definitivos con los tamaños que pida App Store Connect (los actuales en `ios/App/App/Assets.xcassets` sirven para desarrollo/TestFlight).
- Archivar la app en Xcode (Product → Archive) y subirla vía TestFlight/App Store Connect.

## Uso de la app

- Mantén el dedo en la placa central: el eje horizontal cambia el **pitch** y el vertical la **velocidad del barrido** (rate).
- **Latch** deja la sirena sonando sin mantener el dedo.
- **Feedback** dispara la retroalimentación del eco al máximo mientras se mantiene pulsado.
- Controles de **SIREN** (forma de onda, forma del barrido, pitch, rate, depth, spread), **ECHO** (time, repeats, tone, send) y **OUT** (volumen).
- Presets rápidos: AIR RAID, POLICE, LASER, UFO, WHOOP, STEPPA.
