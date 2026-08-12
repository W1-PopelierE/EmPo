<?php

namespace Acme\Http\Controllers;

use Acme\Jobs\ChargeCard;
use Acme\Mailables\WelcomeMail;
use Acme\Models\Order;
use Acme\Notifications\OrderShipped;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Notification;
use Illuminate\Support\Facades\Queue;

class QueueHandoffController
{
    // Five hazards, none of which says `dispatch`. Each hands work to a queue that does not roll
    // back with the transaction enclosing it, so a worker can run before the rows commit.
    public function ship(Order $order, $user, $users): void
    {
        DB::transaction(function () use ($order, $user, $users) {
            Mail::to($user)->queue(new WelcomeMail($order));
            Mail::to($user)->later(now()->addHour(), new WelcomeMail($order));
            Queue::push(new ChargeCard($order));
            $user->notify(new OrderShipped($order));
            Notification::send($users, new OrderShipped($order));
        });
    }
}
