# F1 Racing Simulation

This context describes the physical racing world simulated and presented by HelloRacer WebGL.

## Language

**Circuit**:
A reusable racing course: its physical surface, route, start position, and containment facts, independent of rendering. Silverstone is one Circuit.
_Avoid_: Track when referring to the physical racing course

**Circuit Definition**:
Portable JSON data that describes a Circuit and can be loaded to construct it. It is not visual geometry or renderer configuration.
_Avoid_: Track asset, scene data

**Circuit Catalog**:
The set of shipped Circuit Definitions, addressed by a stable circuit identifier. It selects the Circuit before a session begins.
_Avoid_: Track list, level list
