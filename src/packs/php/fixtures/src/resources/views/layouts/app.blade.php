{{-- The layout every page extends, and the corpus's proof that a template can be a sink. Nothing
     in this file names it: `@extends('layouts.app')` next door is a path below the pack's declared
     view root, and the `view` resolve strategy is what turns the one into the other. --}}
<html>
<body>
    @yield('content')
</body>
</html>
