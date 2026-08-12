<?php

namespace Acme\Http\Controllers;

use Acme\Mailables\WelcomeMail;
use Acme\Models\Order;
use Acme\Notifications\OrderShipped;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;

class SpoolController
{
    // The refusals, every one inside a transaction on purpose: this is the corpus half that proves
    // the queue rules turn down what they are supposed to turn down.
    //
    // The first four report nothing. `Acme\Support\Mail` and `Acme\Support\Queue` are this
    // application's own classes rather than the facades, and the rules are anchored so a
    // namespace-qualified lookalike is not read as one. `notifyNow` delivers in-process, for the
    // `dispatchSync` reason. `Mail::send` queues only when the mailable says so, which the call site
    // cannot see, so it is left out deliberately.
    //
    // The last one reports, unnamed. `later` takes the delay first, so a constructed delay sits
    // where the job does not: the rule wants a comma before the `new` and leaves the job unnamed
    // rather than naming `DateTimeImmutable` as the queued work. An unnamed row is a gap; a row
    // naming the wrong class is a fabricated finding, and the two are not equally acceptable.
    public function spool(Order $order, $user, $mailable): void
    {
        DB::transaction(function () use ($order, $user, $mailable) {
            \Acme\Support\Mail::to($user)->queue(new WelcomeMail($order));
            \Acme\Support\Queue::push(new WelcomeMail($order));
            $user->notifyNow(new OrderShipped($order));
            Mail::to($user)->send(new WelcomeMail($order));
            Mail::to($user)->later(new \DateTimeImmutable('2026-01-01'), $mailable);
        });
    }
}
