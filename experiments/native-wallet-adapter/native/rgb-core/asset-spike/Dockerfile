FROM rust:1.94-slim-trixie@sha256:cf09adf8c3ebaba10779e5c23ff7fe4df4cccdab8a91f199b0c142c53fef3e1a
RUN apt-get update && apt-get install --no-install-recommends -y \
    ca-certificates clang cmake git libssl-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*
RUN rustup component add rustfmt
ENV CARGO_BUILD_JOBS=2 CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0
WORKDIR /source/native/rgb-core/asset-spike
CMD ["cargo", "build", "--locked", "-j", "2"]
