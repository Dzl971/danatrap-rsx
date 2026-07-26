# DanaTrap RSX V5 — Correctif Phase 4.1

- Animation du curseur et de la progression via `requestAnimationFrame` pour un rendu proche de 60 FPS.
- La forme d’onde grise et la forme d’onde jouée sont précalculées puis conservées : elles ne sont plus entièrement redessinées à chaque mise à jour audio.
- Sélection de boucle calculée avec la position réelle dans la zone scrollée et zoomée.
- Sélection et curseur positionnés en pixels sur la même largeur que la forme d’onde.
- Poignées visuelles au début et à la fin de la sélection.
- Lecture en boucle plus précise avec une tolérance réduite.
- Zoom conservant la zone centrale affichée.
- Cache mémoire des pics audio pendant la session.
- Cache PWA renouvelé.
- Version API : `5.0.0-phase4.1`.
