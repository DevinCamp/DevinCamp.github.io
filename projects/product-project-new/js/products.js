/* global $ _ */
$(function(){
$(document).ready(function () {
  // ALL YOUR CODE GOES BELOW HERE //
    $.getJSON('data/product.json', function (data) {
 console.log(data)
      
  
      
       let $section = $('<section>').attr('id', 'top');
      $section.appendTo($('main'));
 
         let list = data;
          $section.append($('<article>')).attr('class', 'row');
          
        _.map(list, function(item){
                let $x = $('<section>').attr('class', 'col-md-9').appendTo('article');
                $('<img>').attr( 'src','img/product/thumbs/'+item.image).attr('class', 'col-md-3').appendTo($x);
                $('<div>').text("Description:  " + item.desc).appendTo($x);
                $('<div>').text("Price:  " + item.price).appendTo($x);
                $('<div>').text("Color:  " + item.color).appendTo($x);            
                $('<div>').text("Stock : " + item.stock).appendTo($x); 
 
            });
            
            
           ('col-md-9').on('click'(function( ){
             
           })) 
         
              
        
   
   
   
    }).fail(function(){console.log('noJSON');});
  // ALL YOUR CODE GOES ABOVE HERE //
    }); 
});





















// function display(array){
//           $('main').empty();
//           if(array.length===0){
//               $('<div>').text('No Items Found').attr('class','text-center').css('font-size','20px').css('font-weight','bold').appendTo('main');
//           }
//           _.each(array, function(product){
//               let row = $('<article>').attr('class','row').css('border-bottom','1px dotted #ccc');    /////hyperlink
//               let thumbnail = 'img/product/thumbs/'+ product.image;
//               $('<img>').attr('src',thumbnail).attr('class','col-md-2').appendTo(row);
//               let mainDesc = $('<section>').attr('class','col-md-6').appendTo(row);
//               $('<a>').text(product.desc).appendTo(mainDesc);