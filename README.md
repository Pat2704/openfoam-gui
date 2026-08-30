### Installation

OpenFOAM Studio is distributed as a standalone Windows application.

1. Download `OpenFOAM-Studio.exe` from the latest release.
2. Move the executable to any folder of your choice.
3. Double-click `OpenFOAM-Studio.exe` to launch the application.

**No Node.js, npm, Docker or manual setup is required.**

### Requirements

* Windows 10 or Windows 11
* WSL2
* Ubuntu installed in WSL2
* OpenFOAM v9–v14

OpenFOAM Studio communicates with OpenFOAM through WSL2.

### OpenFOAM Setup

OpenFOAM must already be installed inside your WSL2 distribution.

OpenFOAM Studio automatically detects available OpenFOAM installations and allows you to select the version you want to use.

For example:

```text
WSL2
└── Ubuntu
    ├── OpenFOAM-9
    ├── OpenFOAM-11
    ├── OpenFOAM-13
    └── OpenFOAM-14
```

