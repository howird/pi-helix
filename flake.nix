{
  description = "pi-helix: reedline (helix/vi) input editor for pi";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    pi = {
      url = "github:earendil-works/pi";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, pi }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        lib = pkgs.lib;

        reedlineRevision = lib.trim (builtins.readFile ./patches/reedline/revision);
        reedlineSource =
          assert lib.assertMsg (builtins.match "[0-9a-f]{40}" reedlineRevision != null)
            "patches/reedline/revision must contain a full lowercase Git commit SHA";
          # The commit SHA is the whole pin: no separate hash to forget when bumping it.
          builtins.fetchGit {
            url = "https://github.com/nushell/reedline";
            rev = reedlineRevision;
            shallow = true;
          };
        # Every patches/reedline/*.patch in name order, as scripts/prepare-reedline.mjs applies them.
        reedlinePatched = pkgs.applyPatches {
          name = "reedline-patched";
          src = reedlineSource;
          patches = map (name: ./patches/reedline + "/${name}")
            (lib.filter (lib.hasSuffix ".patch") (lib.attrNames (builtins.readDir ./patches/reedline)));
        };

        native = pkgs.rustPlatform.buildRustPackage {
          pname = "pi-reedline";
          version = "0.1.0";
          src = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions [ ./Cargo.toml ./Cargo.lock ./crates ];
          };
          cargoLock.lockFile = ./Cargo.lock;
          postPatch = ''
            mkdir -p .reedline
            cp -R ${reedlinePatched} .reedline/reedline
            chmod -R u+w .reedline/reedline
          '';
          cargoBuildFlags = [ "--locked" "-p" "pi-reedline" ];
          # napi symbols only resolve inside node; test the engine without them.
          cargoTestFlags = [ "--locked" "-p" "pi-reedline" "--no-default-features" ];
          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib
            cp target/${pkgs.stdenv.hostPlatform.rust.cargoShortTarget}/release/libpi_reedline${pkgs.stdenv.hostPlatform.extensions.sharedLibrary} $out/lib/pi_reedline.node \
              || cp target/release/libpi_reedline${pkgs.stdenv.hostPlatform.extensions.sharedLibrary} $out/lib/pi_reedline.node
            runHook postInstall
          '';
        };

        # A pi package directory: package.json + src/ + the native addon.
        extension = pkgs.runCommand "pi-helix-0.1.0" { } ''
          mkdir -p $out
          cp ${./package.json} $out/package.json
          cp -r ${./src} $out/src
          cp ${native}/lib/pi_reedline.node $out/pi_reedline.node
        '';

        # pi with this extension loaded: `nix run`, or `nix run . -- <pi args>`.
        launcher = pkgs.writeShellApplication {
          name = "pi-helix";
          runtimeInputs = [ pi.packages.${system}.default ];
          text = ''
            exec pi -e ${extension} "$@"
          '';
        };
      in
      {
        packages.default = extension;

        apps.default = {
          type = "app";
          program = lib.getExe launcher;
        };

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            rustc cargo clippy rustfmt rust-analyzer
            gitMinimal nodejs_22 bun typescript
          ];
        };
      });
}
