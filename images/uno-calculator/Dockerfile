# Uno Calculator (WebAssembly) -- see profiles/uno-calculator/uno-calculator-ce/profile.yaml.
#
# Upstream publishes no image: https://calculator.platform.uno is the static
# output of src/Calculator.Wasm. This builds that output from the pinned
# commit (versions.env), the way upstream's .vsts-ci.Linux.yml does, with two
# changes:
#   * patches/: Google Analytics is never loaded (upstream injects gtag.js
#     on start and reports every mode switch);
#   * the interpreter instead of AOT compilation: a fraction of the build
#     time and memory, and a calculator does not need the speed.
# The result is served by unprivileged nginx; the pod runs no .NET at all.

# The build's output is the same on every architecture, so the build stage
# runs on the builder's own.
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:9.0@sha256:1dfdb27e9c2c345cb598925ccf6b13719ecfebea8467bd4745c23a3c108cdf84 AS build
ARG CALCULATOR_COMMIT
ARG EMSDK_VERSION
RUN test -n "${CALCULATOR_COMMIT}" && test -n "${EMSDK_VERSION}"
RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 xz-utils bzip2 \
 && rm -rf /var/lib/apt/lists/*
# Emscripten for the native engine (src/CalcManager), at the version the
# .NET 9 wasm workload links against.
RUN git clone --branch "${EMSDK_VERSION}" --depth 1 https://github.com/emscripten-core/emsdk /opt/emsdk \
 && /opt/emsdk/emsdk install "${EMSDK_VERSION}" \
 && /opt/emsdk/emsdk activate "${EMSDK_VERSION}" \
 && ln -s /opt/emsdk/node/*/bin/node /usr/local/bin/node
# The Node emscripten brings is also the one the app's TypeScript build
# (Microsoft.TypeScript.MSBuild) runs; upstream's build container has one.
RUN dotnet workload install wasm-tools
WORKDIR /src
RUN git init -q . \
 && git remote add origin https://github.com/unoplatform/calculator.git \
 && git fetch -q --depth 1 origin "${CALCULATOR_COMMIT}" \
 && git checkout -q FETCH_HEAD
COPY patches/ /patches/
RUN for p in /patches/*.patch; do git apply --verbose "$p"; done
RUN bash -c 'source /opt/emsdk/emsdk_env.sh && cd src/CalcManager && bash build.sh'
RUN dotnet publish -c Release src/Calculator.Wasm/Calculator.Wasm.csproj \
      -p:RunAOTCompilation=false \
      -p:WasmShellMonoRuntimeExecutionMode=Interpreter \
      -o /out \
 && test -f /out/wwwroot/index.html

FROM docker.io/nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /out/wwwroot /usr/share/nginx/html
LABEL org.opencontainers.image.title="Uno Calculator" \
      org.opencontainers.image.description="Uno Platform's WebAssembly port of the Windows Calculator, served as static files" \
      org.opencontainers.image.source="https://github.com/unoplatform/calculator" \
      org.opencontainers.image.licenses="MIT"
EXPOSE 8080
